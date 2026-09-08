import { DoubleUnicodeReg, DoubleUnicodePrefixReg, DoubleUnicodeSuffixReg } from './constant.mjs';

function stringLength(text) {
    var _a;
    return text.length - (((_a = text.match(DoubleUnicodeReg)) === null || _a === void 0 ? void 0 : _a.length) || 0);
}
// 双音节字符处理
function splitString(text) {
    DoubleUnicodeReg.lastIndex = 0;
    if (!DoubleUnicodeReg.test(text)) {
        return text.split("");
    }
    const result = [];
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (DoubleUnicodePrefixReg.test(char) &&
            DoubleUnicodeSuffixReg.test(text[i + 1])) {
            result.push(text.substring(i, i + 2));
            i += 2;
        }
        else {
            result.push(char);
            i += 1;
        }
    }
    return result;
}
class FastDictFactory {
    constructor() {
        this.NumberDICT = [];
        this.StringDICT = new Map();
    }
    get(word) {
        if (word.length > 1) {
            return this.StringDICT.get(word);
        }
        else {
            const code = word.charCodeAt(0);
            return this.NumberDICT[code];
        }
    }
    set(word, pinyin) {
        if (word.length > 1) {
            this.StringDICT.set(word, pinyin);
        }
        else {
            const code = word.charCodeAt(0);
            this.NumberDICT[code] = pinyin;
        }
    }
    clear() {
        this.NumberDICT = [];
        this.StringDICT.clear();
    }
}

export { FastDictFactory, splitString, stringLength };
