"""V3 text contracts and deterministic same-child context selection.

This is shared product code, not an evaluation replica. It makes no model calls
and never reads notes or photos. IDs/quotes prove source location, not semantic
correctness. Cards and repair patches are visible task outputs, not reasoning.
"""
from collections import Counter, OrderedDict
import copy
import datetime as dt
import json
import math
import re
import threading

from .dialogue_evidence import EvidenceError, child_sources, digest, normalized_turns


V3_PIPELINES = frozenset({'direct_companion', 'perspective_then_speak', 'selective_repair'})
GOALS = frozenset({'accompany', 'recognize_specific_care', 'share_observation', 'answer_question',
                   'offer_option', 'explore_possibility', 'update_understanding', 'respect_stop', 'safety_support'})
ISSUES = frozenset({'unsupported_event', 'unsafe_advice', 'missed_correction', 'missed_ending',
                    'stable_label', 'off_topic', 'question_budget'})
SELECTION_STRATEGY = 'same-child-weighted-character-ngrams-v1'
_CACHE_LOCK = threading.Lock()
_COMMON_TERMS = frozenset('今天 昨天 明天 上次 这次 后来 然后 我们 你们 他们 它们 自己 那个 这个 一个 一下 时候 就是 不是 没有 已经 还有 小鸭 动物 老师 现在 我说 说了 我想 知道 什么 怎么 因为 所以 的时候 不知道 告诉我 小朋友'.split())


def response_contracts(pipeline_kind, stages):
    def obj(properties):
        return {'type': 'object', 'required': list(properties), 'additionalProperties': False, 'properties': properties}
    def text(maximum, minimum=1):
        return {'type': 'string', 'minLength': minimum, 'maxLength': maximum}
    child_ref = obj({'source_id': text(128), 'quote': text(320)})
    history_ref = obj({'history_id': text(128), 'quote': text(320)})
    reply = obj({'reply': text(4000), 'followUp': text(500, 0), 'endConversation': {'type': 'boolean'}})
    perspective = obj({'focus': text(140), 'evidence': {'type': 'array', 'minItems': 1, 'maxItems': 2, 'items': child_ref},
                       'related_history': {'type': 'array', 'maxItems': 1, 'items': history_ref},
                       'communication_goal': {'enum': sorted(GOALS)}})
    issue = obj({'code': {'enum': sorted(ISSUES)}, 'field': {'enum': ['reply', 'followUp', 'endConversation']},
                 'original': {'type': ['string', 'boolean']}, 'replacement': {'type': ['string', 'boolean']}})
    check = {'oneOf': [obj({'decision': {'const': 'accept'}}),
                       obj({'decision': {'const': 'repair'}, 'issues': {'type': 'array', 'minItems': 1, 'maxItems': 3, 'items': issue}})]}
    schemas = {stage: perspective if stage == 'perspective' else check if stage == 'check' else reply for stage in stages}
    schemas['summary'] = obj({'text': text(200000)})
    return {'response_format': {'type': 'json_object'}, 'response_schemas': schemas,
            'response_schema_sha256': digest(schemas), 'summary_input_kind': 'child_sources_only',
            'summary_response_field': 'text', 'summary_response_format': 'json_object',
            'semantic_validation': 'model_and_human_not_proven_by_format_or_quote_checks',
            'question_policy': 'at_most_one_per_nonterminal_turn_no_first_turn_or_spacing_gate',
            'context_selection_strategy': SELECTION_STRATEGY,
            'context_semantic_recall_guaranteed': False,
            'additional_application_checks': ['literal_source_reference_membership', 'last_child_evidence_required',
                                               'exact_nonoverlapping_repair_spans', 'question_budget', 'no_premature_save_claim'],
            'check_accept_preserves_candidate': pipeline_kind == 'selective_repair'}


def _tokens(text):
    """Transparent lexical relevance; no claim of semantic retrieval recall."""
    terms = set(re.findall(r'[a-z0-9]{2,}', text.lower()))
    for part in re.findall(r'[\u3400-\u9fff]+', text):
        for size in (2, 3):
            terms.update(part[index:index + size] for index in range(len(part) - size + 1))
    return terms - _COMMON_TERMS


def _context_pool(state, draft, animal_types):
    cutoff = dt.datetime.fromisoformat(draft['createdAt'].replace('Z', '+00:00')).timestamp()
    stories = []
    eligible_count = 0
    for record in state['records']:
        # Check ownership and time before touching a record's text. The old
        # recent-three snapshot is deliberately not a retrieval candidate pool.
        if record['child']['id'] != draft['child']['id'] or record['id'] == draft['id']:
            continue
        day = record.get('activityDate', record['createdAt'][:10])
        created = dt.datetime.fromisoformat(record['createdAt'].replace('Z', '+00:00')).timestamp()
        if day > draft['activityDate'] or created > cutoff:
            continue
        eligible_count += 1
        reviewed = bool(record.get('reviewedAt'))
        text = record['text'] if reviewed else '\n'.join(t['text'] for t in record['turns'] if t['role'] == 'child')
        # Never retain a prefix that could omit a later correction.
        if not text.strip() or len(text) > 6000:
            continue
        stories.append({'history_id': record['id'], 'activityDate': day, 'createdAt': record['createdAt'],
                        'reviewStatus': '教师已核对' if reviewed else '未核对的识别原话，可能有误',
                        'sourceKind': 'teacher_reviewed_text' if reviewed else 'child_verbatim', 'text': text})
    stories.sort(key=lambda story: (story['activityDate'], story['createdAt'], story['history_id']), reverse=True)
    animals = [{'name': animal['name'], 'type': animal_types.get(animal.get('animalType'), animal_types['duck'])}
               for animal in state['data']['ducks'] if animal.get('active')]
    pool = {'childName': draft['child']['name'], 'stories': stories, 'animals': animals,
            'eligible_count': eligible_count, 'candidate_count': len(stories),
            'omitted_count': eligible_count - len(stories)}
    pool['pool_sha256'] = digest(pool)
    return pool


class ContextSnapshots:
    """Freeze a text-only pool while resident; restart/eviction is observable."""
    def __init__(self, maximum=16, maximum_chars=2000000):
        self.maximum, self.maximum_chars = maximum, maximum_chars
        self.entries = OrderedDict()
        self.characters = 0
        self.lock = threading.Lock()

    def get(self, state, draft, animal_types):
        identity = (draft['id'], draft['child']['id'], draft['activityDate'], draft['createdAt'])
        with self.lock:
            if identity in self.entries:
                pool, _ = self.entries[identity]
                self.entries.move_to_end(identity)
                return pool, 'reused'
            pool = _context_pool(state, draft, animal_types)
            size = sum(len(story['text']) for story in pool['stories'])
            if size > self.maximum_chars:
                return pool, 'per_request_pool_exceeds_cache_capacity'
            while self.entries and (len(self.entries) >= self.maximum or self.characters + size > self.maximum_chars):
                _, (_, previous_size) = self.entries.popitem(last=False)
                self.characters -= previous_size
            self.entries[identity] = (pool, size)
            self.characters += size
            return pool, 'created_or_rebuilt'


def select_background(server, state, draft, turns, animal_types):
    with _CACHE_LOCK:
        if not hasattr(server, '_dialogue_v3_contexts'):
            server._dialogue_v3_contexts = ContextSnapshots()
    pool, cache_status = server._dialogue_v3_contexts.get(state, draft, animal_types)
    sources = child_sources(turns)
    current_text = sources[-1]['text'] if sources else ''
    current_terms = _tokens(current_text)
    earlier_terms = _tokens('\n'.join(source['text'] for source in sources[:-1]))
    # An explicit animal name is useful. Type alone does not identify an animal.
    named = {animal['name'] for animal in pool['animals'] if animal['name'] in current_text}
    documents = [(story, _tokens(story['text'])) for story in pool['stories']]
    frequency = Counter(term for _, terms in documents for term in terms)
    ranked = []
    for index, (story, terms) in enumerate(documents):
        current_hits = terms & current_terms
        earlier_hits = terms & earlier_terms
        name_hits = {name for name in named if name in story['text']}
        # Require a connection to this turn, or a substantial connection to
        # the child's ongoing story. No recency-only fallback fills empty slots.
        if not current_hits and not name_hits and len(earlier_hits) < 2:
            continue
        weight = lambda term: 1 + math.log((len(documents) + 1) / (frequency[term] + 1))
        score = (4 * sum(weight(term) for term in current_hits)
                 + sum(weight(term) for term in earlier_hits - current_hits) + 8 * len(name_hits))
        score /= 1 + math.log1p(len(terms)) / 8
        ranked.append((score, -index, story, current_hits, earlier_hits, name_hits))
    ranked.sort(key=lambda row: row[:2], reverse=True)
    selected = ranked[:3]
    background = {'childName': pool['childName'], 'recentStories': [copy.deepcopy(row[2]) for row in selected],
                  'animals': copy.deepcopy(pool['animals'])}
    metadata = {'strategy': SELECTION_STRATEGY, 'eligible_count': pool['eligible_count'],
                'candidate_count': pool['candidate_count'], 'omitted_count': pool['omitted_count'],
                'related_candidate_count': len(ranked), 'selected_ids': [row[2]['history_id'] for row in selected],
                'selected': [{'history_id': row[2]['history_id'], 'score': round(row[0], 4),
                              'current_matches': sorted(row[3])[:24], 'conversation_matches': sorted(row[4])[:24],
                              'explicit_name_matches': sorted(row[5])} for row in selected],
                'pool_sha256': pool['pool_sha256'], 'cache_status': cache_status,
                'snapshot_scope': 'first_v3_request_while_resident_not_persisted',
                'query_source': 'current_child_and_prior_child_text_only', 'max_selected': 3,
                'semantic_relevance_verified': False}
    return background, metadata


def _object(value, keys, code):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise EvidenceError(code, 'JSON 字段必须恰好为：' + ', '.join(keys) + '。')


def _text(value, maximum, code, *, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or value != value.strip()
            or (not empty and not value)):
        raise EvidenceError(code, f'文字必须无首尾空白，长度为 {0 if empty else 1}–{maximum} 字。')
    return value


def _parse(output):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_field')
            result[key] = value
        return result
    try:
        value = json.loads(output, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non_json_number')))
    except (ValueError, TypeError, RecursionError):
        raise EvidenceError('invalid_json_object', '必须输出一个完整 JSON 对象；不要 Markdown、重复字段或额外文字。') from None
    if not isinstance(value, dict):
        raise EvidenceError('invalid_json_object', '顶层必须是 JSON 对象。')
    return value


def _unquoted_questions(text):
    # Preserve quoted child questions; this counts explicit punctuation only,
    # not the old phrase filter. It is not a semantic non-leading-question test.
    unquoted = re.sub(r'“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|‘[^’]*’', '', text)
    return len(re.findall(r'[？?]+', unquoted))


def validate_reply(value, control):
    _object(value, ('reply', 'followUp', 'endConversation'), 'invalid_reply_fields')
    _text(value['reply'], 4000, 'invalid_reply_text')
    _text(value['followUp'], 500, 'invalid_follow_up', empty=True)
    if type(value['endConversation']) is not bool:
        raise EvidenceError('invalid_end_conversation', 'endConversation 必须是布尔值。')
    questions = _unquoted_questions(value['reply']) + _unquoted_questions(value['followUp'])
    allowed = control['questionAllowed'] and not control['forceClosing'] and not value['endConversation']
    if not allowed and (value['followUp'] or questions):
        raise EvidenceError('question_not_allowed', '这轮收尾或儿童想停止，不能提问；followUp 必须为空。')
    if questions > 1 or (value['followUp'] and (not value['followUp'].endswith(('?', '？')) or _unquoted_questions(value['followUp']) != 1)):
        raise EvidenceError('too_many_questions', '本轮最多一个问题；followUp 非空时只含一个以问号结束的问题。')
    if re.search(r'记下来了|记好了|保存好了|保存成功|已经保存', value['reply'] + value['followUp']):
        raise EvidenceError('premature_save_claim', '记录尚未保存；不要宣称已记好或保存成功。')
    return copy.deepcopy(value)


def _reference(value, catalog, id_key, maximum=320):
    _object(value, (id_key, 'quote'), 'invalid_source_reference')
    source_id = value[id_key]
    if not isinstance(source_id, str) or source_id not in catalog:
        raise EvidenceError('unknown_source_reference', id_key + ' 必须来自本次提供的资料。')
    quote = _text(value['quote'], maximum, 'invalid_source_quote')
    if quote not in catalog[source_id]['text']:
        raise EvidenceError('source_quote_not_verbatim', 'quote 必须是该编号资料中的连续逐字原文，不得改写。')
    return copy.deepcopy(value)


def validate_perspective(value, sources, background):
    _object(value, ('focus', 'evidence', 'related_history', 'communication_goal'), 'invalid_perspective_fields')
    _text(value['focus'], 140, 'invalid_perspective_focus')
    if not isinstance(value['communication_goal'], str) or value['communication_goal'] not in GOALS:
        raise EvidenceError('invalid_communication_goal', 'communication_goal 必须是模板列出的有限目的之一。')
    evidence = value['evidence']
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 2:
        raise EvidenceError('invalid_perspective_evidence', 'evidence 必须有 1–2 个儿童逐字引文。')
    catalog = {source['source_id']: source for source in sources}
    for ref in evidence:
        _reference(ref, catalog, 'source_id')
    if not sources or sources[-1]['source_id'] not in {ref['source_id'] for ref in evidence}:
        raise EvidenceError('current_source_missing', 'evidence 至少包含最后一段儿童原话的引文。')
    history = value['related_history']
    if not isinstance(history, list) or len(history) > 1:
        raise EvidenceError('invalid_perspective_history', 'related_history 必须为空或只有一条历史引文。')
    histories = {item['history_id']: item for item in (background or {}).get('recentStories', [])}
    for ref in history:
        _reference(ref, histories, 'history_id')
    return copy.deepcopy(value)


def apply_check(value, candidate, control):
    if value == {'decision': 'accept'}:
        # No parsing, stripping or stylistic normalization on this branch.
        return copy.deepcopy(candidate)
    _object(value, ('decision', 'issues'), 'invalid_check_fields')
    if value['decision'] != 'repair' or not isinstance(value['issues'], list) or not 1 <= len(value['issues']) <= 3:
        raise EvidenceError('invalid_check_decision', '只可 accept，或 repair 并给出 1–3 个明确问题及最小替换。')
    edits = {}
    result = copy.deepcopy(candidate)
    for issue in value['issues']:
        _object(issue, ('code', 'field', 'original', 'replacement'), 'invalid_repair_fields')
        if not isinstance(issue['code'], str) or issue['code'] not in ISSUES:
            raise EvidenceError('invalid_repair_code', '问题码必须是模板列出的实质问题，不能只为润色改写。')
        field = issue['field']
        if not isinstance(field, str) or field not in candidate:
            raise EvidenceError('invalid_repair_target', '只能修补 reply、followUp 或 endConversation。')
        original, replacement = issue['original'], issue['replacement']
        if field == 'endConversation':
            if (type(original) is not bool or type(replacement) is not bool or original != candidate[field]
                    or original == replacement or field in edits):
                raise EvidenceError('invalid_end_repair', '结束标记修补必须由候选的原布尔值变成另一个布尔值。')
            edits[field] = [(0, 1, replacement)]
        else:
            if (not isinstance(original, str) or not original or not isinstance(replacement, str)
                    or len(replacement) > 4000 or original == replacement or candidate[field].count(original) != 1):
                raise EvidenceError('repair_quote_not_unique', 'original 必须是候选字段中仅出现一次的非空原片段，replacement 必须有实际修改。')
            start = candidate[field].index(original)
            end = start + len(original)
            if any(start < previous_end and end > previous_start for previous_start, previous_end, _ in edits.get(field, [])):
                raise EvidenceError('overlapping_repairs', '修补片段不能重叠，且全部 original 应定位于未修改的候选。')
            edits.setdefault(field, []).append((start, end, replacement))
    for field, patches in edits.items():
        if field == 'endConversation':
            result[field] = patches[0][2]
        else:
            for start, end, replacement in sorted(patches, reverse=True):
                result[field] = result[field][:start] + replacement + result[field][end:]
    return validate_reply(result, control)


class DialogueRun:
    """Stage state only; app.py owns all real calls, timing and shared retries."""
    def __init__(self, profile, operation, turns, background, control):
        self.profile, self.operation, self.control = profile, operation, control
        self.stages = list(profile['metadata']['required_chat_stages']) if operation == 'chat' else ['summary']
        self.index = 0
        self.sources = child_sources(turns)
        self.background = background
        self.materials = {'transcript': normalized_turns(turns), 'child_sources': self.sources, 'background': background}
        self.perspective = None
        self.candidate = None
        self.final = None

    @property
    def stage(self):
        return self.stages[self.index]

    def messages(self):
        if self.operation == 'summary':
            return [{'role': 'system', 'content': self.profile['summary_prompt']},
                    {'role': 'user', 'content': json.dumps({'child_sources': self.sources}, ensure_ascii=False)}]
        system = self.profile['stage_prompts'][self.stage] + '\napplication_control=' + json.dumps(self.control, ensure_ascii=False)
        data = {'materials': self.materials}
        if self.profile['metadata'].get('chat_input_representation') == 'transcript_once_plus_allowed_background':
            data = {'materials': {'transcript': self.materials['transcript'], 'background': self.background}}
        if self.profile['metadata']['id'] == 'case-based-friend-v4':
            from .friend_profiles import select_examples
            data = {'demonstrations': select_examples(self.materials['transcript'], self.background), **data}
        elif self.profile['metadata'].get('demonstration_strategy') == 'semantic-reference-library-v1':
            from .friend_profiles_v5 import reference_examples
            data = {'demonstrations': reference_examples(), **data}
        if self.stage == 'speaker':
            data['perspective'] = self.perspective
        if self.stage == 'check':
            data['candidate'] = self.candidate
        return [{'role': 'system', 'content': system}, {'role': 'user', 'content': json.dumps(data, ensure_ascii=False)}]

    def accept(self, output):
        value = _parse(output)
        if self.stage == 'summary':
            _object(value, ('text',), 'invalid_summary_fields')
            self.final = _text(value['text'], 200000, 'invalid_summary_text')
            return {'envelope': value, 'validated_text': self.final}, True
        if self.stage == 'perspective':
            self.perspective = validate_perspective(value, self.sources, self.background)
            result = {'perspective': self.perspective, 'validation_scope': 'finite_fields_source_ids_exact_quotes_not_semantic_truth'}
        elif self.stage == 'check':
            self.final = apply_check(value, self.candidate, self.control)
            result = {'check': value, 'envelope': self.final,
                      'candidate_preserved_exactly': self.final == self.candidate,
                      'validation_scope': 'finite_codes_exact_patch_locations_and_reply_shape_not_semantic_truth'}
        else:
            envelope = validate_reply(value, self.control)
            if self.stage == 'candidate':
                self.candidate = envelope
            self.final = envelope
            result = {'envelope': envelope, 'validated_reply': envelope['reply']}
        complete = self.index == len(self.stages) - 1
        if not complete:
            self.index += 1
        return result, complete

    def delivered_text(self):
        return self.final['reply'] + self.final['followUp']
