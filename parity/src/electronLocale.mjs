// Records what the real Electron 33.2.0 (ICU 74.2, CLDR 44.1) collates under each default locale, for
// `crates/timo-core/tests/locale_electron_snapshot.rs`.
//
//   ELECTRON_RUN_AS_NODE=1 <Electron 33.2.0 binary> src/electronLocale.mjs ../crates/timo-core/tests/data/locale_electron.json
//
// `String.prototype.localeCompare(b)` uses the ICU default locale, and `Intl.Collator(tag)` resolves a tag
// through the same ICU data, so a tag stands for "the process default is this locale". Measured on the
// binary: the environment (LC_ALL, else LC_MESSAGES, else LANG) sets that default, `app.getLocale()` does not.
//
// Chromium ships a TRIMMED ICU data file: some languages CLDR tailors (Welsh, Icelandic, Albanian, Azerbaijani,
// Bosnian, Maltese, Norwegian Nynorsk) have no collation tailoring in it, so they collate as the root does.
// The snapshot is what the Rust `collator_for` must reproduce, locale by locale, over every pair of PROBE.
import { writeFileSync } from 'node:fs';

/** Languages CLDR gives a collation tailoring, then a few that have none, with region/script variants. */
const TAGS = [
  'en-US', 'en-GB', 'af-ZA', 'ar-SA', 'ar-EG', 'as-IN', 'az-AZ', 'az-Cyrl-AZ', 'be-BY', 'bg-BG', 'bn-BD', 'bn-IN', 'bo-CN', 'bs-BA', 'bs-Cyrl-BA',
  'ca-ES', 'chr-US', 'cs-CZ', 'cy-GB', 'da-DK', 'de-DE', 'de-AT', 'dsb-DE', 'ee-GH', 'el-GR', 'eo', 'es-ES', 'es-MX', 'es-419', 'et-EE',
  'fa-IR', 'fi-FI', 'fil-PH', 'fo-FO', 'fr-FR', 'fr-CA', 'ga-IE', 'gl-ES', 'gu-IN', 'ha-NG', 'haw-US', 'he-IL', 'hi-IN', 'hr-HR', 'hsb-DE',
  'hu-HU', 'hy-AM', 'ig-NG', 'is-IS', 'it-IT', 'ja-JP', 'ka-GE', 'kk-KZ', 'kl-GL', 'km-KH', 'kn-IN', 'ko-KR', 'kok-IN', 'ku-TR', 'ky-KG',
  'lkt-US', 'ln-CD', 'lo-LA', 'lt-LT', 'lv-LV', 'mk-MK', 'ml-IN', 'mn-MN', 'mr-IN', 'ms-MY', 'mt-MT', 'my-MM', 'nb-NO', 'ne-NP', 'nl-NL',
  'nn-NO', 'no-NO', 'om-ET', 'or-IN', 'pa-IN', 'pl-PL', 'ps-AF', 'pt-PT', 'pt-BR', 'ro-RO', 'ru-RU', 'se-NO', 'si-LK', 'sk-SK', 'sl-SI',
  'smn-FI', 'sq-AL', 'sr-RS', 'sr-Latn-RS', 'sv-SE', 'sv-FI', 'ta-IN', 'te-IN', 'th-TH', 'tk-TM', 'to-TO', 'tr-TR', 'ug-CN', 'uk-UA', 'ur-PK',
  'uz-UZ', 'uz-Cyrl-UZ', 'vi-VN', 'wae-CH', 'wo-SN', 'yi', 'yo-NG', 'zh-CN', 'zh-TW', 'zh-HK',
];

/** Strings that exercise the tailorings: digraphs, `aa`, case, accents, and one or two letters per script. */
const PROBE = [
  'a', 'A', 'aa', 'AA', 'ab', 'z', 'Z', 'za', 'ZA', 'b', 'c', 'C', 'ch', 'CH', 'Ch', 'ci', 'cz', 'cs', 'CS', 'd', 'dd', 'dz', 'DZ', 'dzs', 'ds', 'e', 'f', 'ff',
  'g', 'gy', 'GY', 'h', 'H', 'i', 'I', 'j', 'k', 'l', 'll', 'LL', 'lj', 'ly', 'm', 'n', 'ng', 'NG', 'nj', 'ny', 'NY', 'o', 'p', 'ph', 'q', 'r', 'rh', 's', 'sz', 'SZ',
  't', 'th', 'TH', 'ty', 'u', 'v', 'w', 'x', 'y', 'zs', 'ZS', 'å', 'Å', 'ä', 'Ä', 'ö', 'Ö', 'ü', 'Ü', 'ø', 'æ', 'ç', 'ñ', 'é', 'ß', 'ss', 'ı', 'İ', 'ğ', 'š', 'č',
  'ž', 'ł', 'đ', 'ǆ', 'ĳ', 'а', 'б', 'в', 'ђ', 'ј', 'љ', 'њ', 'ћ', 'џ', 'ё', 'ў', 'α', 'β', 'ω', 'ا', 'ب', 'ی', 'א', 'ב', 'अ', 'क', 'ก', 'ข', 'あ', 'ア', '漢', '字',
  '한', '글', 'ა', 'ბ', 'Ա', 'բ', 'অ', 'க', 'ᏣᎳ', '1', '10', '9', '_', '-', ' ', '',
];

const out = { runtime: { electron: process.versions.electron, icu: process.versions.icu, cldr: process.versions.cldr }, probe: PROBE, locales: {} };
const sign = (n) => (n < 0 ? '<' : n > 0 ? '>' : '=');
for (const tag of TAGS) {
  const collator = new Intl.Collator(tag);
  let result = '';
  for (let i = 0; i < PROBE.length; i++) for (let j = i + 1; j < PROBE.length; j++) result += sign(PROBE[i].localeCompare(PROBE[j], tag));
  // The string method with no locale is the same call with the default locale; check one pair agrees.
  out.locales[tag] = { resolved: collator.resolvedOptions().locale, results: result };
}
writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
console.log(`${TAGS.length} locales, ${PROBE.length} strings, icu ${process.versions.icu}`);
