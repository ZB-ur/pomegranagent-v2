"""Observable dialogue structures, source linkage and episode-bound ledgers.

Validation proves IDs, exact quote locations and source coverage, not semantic
entailment. The second model call still reviews every fact against child text.
No rationale, hidden reasoning, provider secret or assistant praise is a source.
"""
from collections import OrderedDict
import copy
import hashlib
import json
import threading
import time


DIALOGUE_ACTS = frozenset({
    'recognize_care', 'notice_change', 'recognize_observation', 'recognize_adjustment',
    'answer_question', 'accept_uncertainty', 'accept_correction', 'accept_ending',
    'safety_response', 'receive_story',
})
FACT_KINDS = frozenset({'action', 'observation', 'intention', 'uncertainty', 'correction', 'utterance'})
EXCLUSION_REASONS = frozenset({'ending_only', 'question_only', 'no_clear_event', 'instruction_only'})
MEMORY_PURPOSES = frozenset({'concrete_change', 'method_adjustment', 'open_question', 'explicit_recall'})
_CACHE_CREATION_LOCK = threading.Lock()


class EvidenceError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def digest(value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


def normalized_turns(turns):
    if not isinstance(turns, list):
        raise EvidenceError('invalid_transcript', '原始对话结构无效。')
    result = []
    for turn in turns:
        if (not isinstance(turn, dict) or turn.get('role') not in ('child', 'assistant', 'system')
                or not isinstance(turn.get('text'), str) or not turn['text'].strip()):
            raise EvidenceError('invalid_transcript', '原始对话结构无效。')
        if turn['role'] != 'system':
            result.append({'role': turn['role'], 'text': turn['text']})
    return result


def child_sources(turns):
    return [{'source_id': f'child-{index:04d}', 'text': turn['text'],
             'text_sha256': hashlib.sha256(turn['text'].encode('utf-8')).hexdigest()}
            for index, turn in enumerate((t for t in normalized_turns(turns) if t['role'] == 'child'), 1)]


def memory_options(background):
    if not isinstance(background, dict):
        return []
    return [{'memory_id': f'history-{index:02d}', 'activity_date': story['activityDate'],
             'review_status': story['reviewStatus'], 'text': story['text']}
            for index, story in enumerate(background.get('recentStories', []), 1)
            if isinstance(story.get('text'), str) and story['text'].strip() and not story.get('omitted')]


def _text(value, limit, code):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise EvidenceError(code, '结构化内容的文字字段缺失或过长。')
    return value


def _quote(reference, sources, code):
    if not isinstance(reference, dict) or set(reference) != {'source_id', 'quote'}:
        raise EvidenceError(code, '原话引用格式无效。')
    source_id = reference['source_id']
    if not isinstance(source_id, str) or source_id not in sources:
        raise EvidenceError(code, '原话引用没有对应的儿童来源。')
    quote = _text(reference['quote'], 60000, code)
    original = sources[source_id]['text']
    if quote not in original or (len(quote.strip()) < 2 and quote != original):
        raise EvidenceError(code, '原话引文不能在对应儿童发言中逐字定位。')
    return {'source_id': source_id, 'quote': quote}


def validate_ledger(value, sources):
    code = 'invalid_evidence_ledger'
    if not isinstance(value, dict) or set(value) != {'facts', 'excluded_sources'}:
        raise EvidenceError(code, '事实账本字段不完整。')
    facts, excluded = value['facts'], value['excluded_sources']
    if not isinstance(facts, list) or len(facts) > 120 or not isinstance(excluded, list) or len(excluded) > len(sources):
        raise EvidenceError(code, '事实账本长度或格式无效。')
    catalog = {source['source_id']: source for source in sources}
    covered = set()
    clean_facts = []
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {'kind', 'text', 'source_refs'}:
            raise EvidenceError(code, '事实条目结构无效。')
        if not isinstance(fact['kind'], str) or fact['kind'] not in FACT_KINDS:
            raise EvidenceError(code, '事实类型无效；不能使用能力、品质或聊天评价作为事实。')
        text = _text(fact['text'], 1200, code)
        refs = fact['source_refs']
        if not isinstance(refs, list) or not 1 <= len(refs) <= len(sources):
            raise EvidenceError(code, '事实条目必须有儿童原话引用。')
        clean_refs = [_quote(ref, catalog, code) for ref in refs]
        if len({ref['source_id'] for ref in clean_refs}) != len(clean_refs):
            raise EvidenceError(code, '同一事实的来源编号重复。')
        covered.update(ref['source_id'] for ref in clean_refs)
        clean_facts.append({'kind': fact['kind'], 'text': text, 'source_refs': clean_refs})
    excluded_ids = set()
    clean_excluded = []
    for source in excluded:
        if not isinstance(source, dict) or set(source) != {'source_id', 'reason'}:
            raise EvidenceError(code, '排除来源结构无效。')
        source_id, reason = source['source_id'], source['reason']
        if (not isinstance(source_id, str) or source_id not in catalog or source_id in covered
                or source_id in excluded_ids or not isinstance(reason, str) or reason not in EXCLUSION_REASONS):
            raise EvidenceError(code, '排除来源无效或与已引用来源冲突。')
        excluded_ids.add(source_id)
        clean_excluded.append({'source_id': source_id, 'reason': reason})
    if covered | excluded_ids != set(catalog):
        raise EvidenceError(code, '事实账本没有交代全部儿童发言来源。')
    return {'facts': clean_facts, 'excluded_sources': clean_excluded}


def validate_memory_selection(value, sources, memories):
    if value is None:
        return None
    code = 'invalid_memory_selection'
    if not isinstance(value, dict) or set(value) != {'memory_id', 'quote', 'purpose', 'current_source'}:
        raise EvidenceError(code, '历史选择只能为空或一条有来源的记录。')
    catalog = {memory['memory_id']: memory for memory in memories}
    memory_id = value['memory_id']
    if not isinstance(memory_id, str) or memory_id not in catalog:
        raise EvidenceError(code, '所选历史不在本次允许材料中。')
    quote = _text(value['quote'], 6000, code)
    if quote not in catalog[memory_id]['text'] or len(quote.strip()) < 2:
        raise EvidenceError(code, '历史引文不能在所选记录中逐字定位。')
    if not isinstance(value['purpose'], str) or value['purpose'] not in MEMORY_PURPOSES:
        raise EvidenceError(code, '历史联系用途无效。')
    current = _quote(value['current_source'], {s['source_id']: s for s in sources[-1:]}, code)
    return {'memory_id': memory_id, 'quote': quote, 'purpose': value['purpose'], 'current_source': current}


def validate_structure(pipeline_kind, envelope, sources, memories):
    field = {'dialogue_act': 'dialogue_act', 'evidence_ledger': 'evidence_ledger',
             'selective_memory': 'memory_selection'}.get(pipeline_kind)
    if field and set(envelope) != {'reply', 'followUp', 'endConversation', field}:
        raise EvidenceError('invalid_structure_fields', '回应结构只能包含可交付文字与指定的有限结构字段。')
    if pipeline_kind == 'dialogue_act':
        act = envelope.get('dialogue_act')
        if not isinstance(act, str) or act not in DIALOGUE_ACTS:
            raise EvidenceError('invalid_dialogue_act', '交流动作标签缺失或无效。')
        return {'dialogue_act': act}
    if pipeline_kind == 'evidence_ledger':
        return {'evidence_ledger': validate_ledger(envelope.get('evidence_ledger'), sources)}
    if pipeline_kind == 'selective_memory':
        if 'memory_selection' not in envelope:
            raise EvidenceError('invalid_memory_selection', '未明确选择或放弃历史联系。')
        return {'memory_selection': validate_memory_selection(envelope['memory_selection'], sources, memories)}
    return {}


def bind_saved_draft(state, value, turns, *, require_child_last=False):
    story_id, child_id = value.get('storyId'), value.get('childId')
    if not isinstance(story_id, str) or not story_id or not isinstance(child_id, str) or not child_id:
        raise EvidenceError('ledger_identity_missing', '事实账本需要对应故事与幼儿的已保存草稿。')
    matches = [draft for draft in state['drafts'].values()
               if draft['id'] == story_id and draft['child']['id'] == child_id
               and (value.get('activityDate') is None or draft['activityDate'] == value['activityDate'])]
    if len(matches) != 1:
        raise EvidenceError('ledger_draft_missing', '未找到唯一对应的已保存草稿，不能使用事实账本。')
    draft = matches[0]
    transcript = normalized_turns(turns)
    if normalized_turns(draft['turns']) != transcript:
        raise EvidenceError('ledger_draft_mismatch', '本轮原始对话与已保存草稿不同，请先保存原话。')
    if require_child_last and (not transcript or transcript[-1]['role'] != 'child'):
        raise EvidenceError('ledger_pending_child_missing', '事实提取需要以本轮儿童原话结束的草稿。')
    return (story_id, child_id, draft['activityDate'])


def _profile_binding(metadata):
    return {key: metadata.get(key) for key in ('id', 'version', 'pipeline_kind',
                                             'candidate_template_sha256', 'review_template_sha256',
                                             'summary_template_sha256')}


class EvidenceCache:
    """Bounded in-memory cache. Restart/mismatch is explicit, never a raw fallback."""
    def __init__(self, maximum=128, ttl_seconds=21600):
        self.maximum, self.ttl_seconds = maximum, ttl_seconds
        self._entries = OrderedDict()
        self._lock = threading.Lock()

    def put(self, identity, turns, ledger, metadata):
        sources = child_sources(turns)
        reviewed = validate_ledger(ledger, sources)
        entry = {'schema_version': 'child-facts-v1', 'identity': list(identity),
                 'profile': _profile_binding(metadata), 'reviewed_ledger': reviewed,
                 'child_sources': sources, 'source_catalog_sha256': digest(sources),
                 'delivered_transcript_sha256': digest(normalized_turns(turns)),
                 'source_validation': 'ids_exact_quotes_and_source_coverage_only',
                 'semantic_validation': 'second_model_review_not_independent_truth'}
        entry['ledger_sha256'] = digest(entry)
        with self._lock:
            self._entries[identity] = (time.monotonic(), copy.deepcopy(entry))
            self._entries.move_to_end(identity)
            while len(self._entries) > self.maximum:
                self._entries.popitem(last=False)
        return copy.deepcopy(entry)

    def get(self, identity, turns, metadata):
        with self._lock:
            pair = self._entries.get(identity)
            if pair is None:
                raise EvidenceError('ledger_cache_missing', '没有本故事已审校的事实账本；服务重启后需重新接话，不能直接按账本整理。')
            created, entry = pair
            if time.monotonic() - created > self.ttl_seconds:
                del self._entries[identity]
                raise EvidenceError('ledger_cache_expired', '本故事事实账本已过期，不能直接按账本整理。')
            if entry['profile'] != _profile_binding(metadata):
                raise EvidenceError('ledger_profile_mismatch', '本故事事实账本的对话策略版本不一致。')
            if entry['delivered_transcript_sha256'] != digest(normalized_turns(turns)):
                raise EvidenceError('ledger_transcript_mismatch', '原始对话已变化或最终回复尚未保存，不能使用旧事实账本。')
            if entry['source_catalog_sha256'] != digest(child_sources(turns)):
                raise EvidenceError('ledger_sources_mismatch', '儿童原话已变化，不能使用旧事实账本。')
            self._entries.move_to_end(identity)
            return copy.deepcopy(entry)


def evidence_cache(server):
    with _CACHE_CREATION_LOCK:
        if not hasattr(server, '_dialogue_evidence_cache'):
            server._dialogue_evidence_cache = EvidenceCache()
        return server._dialogue_evidence_cache
