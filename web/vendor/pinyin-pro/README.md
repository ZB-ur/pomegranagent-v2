# pinyin-pro 3.29.3

Source: https://github.com/zh-lx/pinyin-pro

Package: https://registry.npmjs.org/pinyin-pro/-/pinyin-pro-3.29.3.tgz

License: MIT; original notice is preserved in `LICENSE`.

This directory contains the ESM `match` module and its transitive
dependencies from the published package. Only CRLF line endings were normalized
to LF; code is otherwise unchanged. Other unused modules were omitted.
The package SHA-512 integrity was verified before extraction:

`sha512-+UU9bx6vfDw8amOJGHm0TE0rdQl8VPylsDWviQ5OOQ3e+on1xRP4OqDbiDuMT5OISgvfl/Y6ez1BBRaIP80GLQ==`

The teacher's day picker matches names locally, without a CDN, remote lookup,
or sending children's names to another service. It accepts Chinese text,
pinyin initials, full pinyin, and mixed forms, ignoring case and whitespace.
Matches must cover consecutive name characters. Known alternate pronunciations
are accepted to reduce missed names; this can produce extra matches for
polyphonic characters and does not determine a child's actual pronunciation.
Rare characters or family-specific pronunciations absent from the library's
dictionary may require searching the Chinese name directly.

API documentation: https://pinyin-pro.cn/use/match.html
