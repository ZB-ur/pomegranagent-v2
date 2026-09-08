const DoubleUnicodePrefixReg = /^[\uD800-\uDBFF]$/;
const DoubleUnicodeSuffixReg = /^[\uDC00-\uDFFF]$/;
const DoubleUnicodeReg = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
var Probability;
(function (Probability) {
    Probability[Probability["Unknown"] = 1e-13] = "Unknown";
    Probability[Probability["Rule"] = 1e-12] = "Rule";
    Probability[Probability["DICT"] = 2e-8] = "DICT";
    Probability[Probability["Surname"] = 1] = "Surname";
    Probability[Probability["Custom"] = 1] = "Custom";
})(Probability || (Probability = {}));
const Priority = {
    Normal: 1,
    Surname: 10,
    Custom: 100,
};

export { DoubleUnicodePrefixReg, DoubleUnicodeReg, DoubleUnicodeSuffixReg, Priority, Probability };
