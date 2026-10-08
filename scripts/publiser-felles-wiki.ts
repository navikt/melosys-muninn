#!/usr/bin/env bun
/**
 * Publiserer sider fra en lokal wiki-mappe til felles-wiki-bøtta, som
 * melosys-muninn speiler og viser skrivebeskyttet på
 * /wiki?wiki=melosys-felles. Sletter objekter med `--fjern`.
 *
 *   bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot> <relPath>...
 *   bun scripts/publiser-felles-wiki.ts --fjern [--ja] [--dry-run] [--bucket <navn>] [--] <relPath>...
 *
 * `--fjern` sletter bare objektene som oppgis: datafilene en side viser, må
 * oppgis i tillegg til siden, ellers blir de liggende i bøtta.
 *
 * Skanneren er det eneste automatiske vernet mot personopplysninger: poden viser
 * alt i bøtta til hele teamet. Hver fil sjekkes, og en fil som feiler, lastes
 * ikke opp:
 *   - sti: speilets egne regler — bare .md, .mdx, .html og `.wiki-reader.json`
 *     på rotnivå, og datafilene en side viser (se under); ingen skjulte
 *     segmenter, `..`, omvendt skråstrek, kontroll-
 *     eller retningstegn, eller segmenter over 211 byte. I tillegg avvises
 *     jokertegnene `[ ] * ?` (gcloud tolker dem som mønster), navn som slutter
 *     på `#<sifre>` (gcloud leser det som en objektversjon), symlenker og navn
 *     som kolliderer med et annet levende objekt under små bokstaver + NFC.
 *     Bilder og uttrekk (.json .tsv .xlsx .txt) publiseres aldri.
 *   - datafiler: en side lastes opp sammen med filene dens `<Query csv= sql=>`,
 *     `<CaseBoard src=>` og `<DeltaTable src=>` navngir (.csv .sql .yaml .yml),
 *     uansett hvor under wiki-roten de ligger. Porten (`navngitteDatafiler`)
 *     finner minst det muninns leser leser, og noen ganger mer. En .csv, .sql
 *     eller .yaml som oppgis alene, uten en side som viser den, avvises, og en
 *     datafil lastes bare opp når minst én side som viser den, er godkjent og
 *     lastet opp i samme kjøring. Datafiler skannes som sider, men uten
 *     `--tillat-ident`: er alle funnene i en CSV NAVident, fjernes hver kolonne
 *     med et funn fra kopien som lastes opp, og kopien skannes på nytt.
 *     Kildefilen endres ikke. Bare kommadelt, rektangulær CSV renses; filen
 *     avvises når et anførselstegn aldri lukkes eller følges av tekst før neste
 *     komma eller linjeskift, når en overskriftscelle uten anførselstegn har
 *     semikolon eller tabulator, når overskriften (første rad som ikke er en
 *     tom linje) har færre enn to kolonner, når en rad som ikke er tom har et
 *     annet antall kolonner enn overskriften, når det blir ingen kolonner igjen, og
 *     når kopien blir større enn 1 MB. En NAVident i en .sql eller .yaml avvises,
 *     og et fødselsnummer, D-nummer, H-nummer, en e-postadresse eller et
 *     organisasjonsnummer avvises i alle datafiler, før noen kolonne fjernes.
 *   - størrelse: over 2 MB for en side, 1 MB for en datafil, hopper speilet
 *     over objektet, så det avvises her.
 *   - koding: UTF-16 og UTF-32 (merke eller NUL-byte) avvises.
 *   - innhold og filnavn: fødselsnummer, D-nummer og H-nummer (kontrollsifre +
 *     dato), organisasjonsnummer (kontrollsiffer i datalignende kontekst),
 *     e-postadresser og NAVident. Teksten normaliseres først (NFKC, HTML-
 *     entiteter, usynlige tegn), så også sifre skilt av tabellceller eller
 *     formatering fanges. Bare e-post og NAVident kan slippes med
 *     `--tillat-ident`; et fødselsnummer har ingen overstyring.
 *   - culled: `signal: none` i frontmatter eller
 *     `<meta name="wiki-signal" content="none">`.
 * Verdier skrives maskert til de to siste tegnene. En sti med funn, også en
 * `--tillat-ident` slipper gjennom, skrives bare maskert — også i adressen og
 * i gcloud sine feilmeldinger.
 *
 * Opplastingen sender de skannede byteene via stdin (`gcloud storage cp -`),
 * så filen leses bare én gang.
 *
 * Exit-koder: 0 alt gikk bra; 1 minst én fil avvist av sjekken, eller
 * slettingen ble ikke bekreftet; 2 feil bruk eller miljø, også en objektliste
 * som ikke kan leses eller har uventet form (ingenting er gjort);
 * 3 minst én opplasting eller sletting feilet (de andre er gjennomført).
 *
 * Bøtte: `--bucket`, ellers FELLES_WIKI_BUCKET (tom verdi teller ikke), ellers
 * `felles_wiki_bucket` i nais/vars.json. Ingen avhengigheter utover Bun og
 * `gcloud`.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const SIDE_ENDELSER = new Set([".md", ".mdx", ".html"]);
export const BILDE_ENDELSER = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp", ".ico", ".tif", ".tiff"]);
export const UTTREKK_ENDELSER = new Set([".tsv", ".json", ".xlsx", ".xls", ".txt"]);
export const LESER_KONFIG = ".wiki-reader.json";
/** Speilet hopper over objekter større enn dette (MAX_OBJECT_BYTES i muninn). */
export const MAKS_BYTES = 2 * 1024 * 1024;
/** Grensen for en datafil: speilet og leseren tar ikke større (PAGE_FILE_MAX_BYTES i muninn). */
export const MAKS_DATA_BYTES = 1024 * 1024;
/** Speilets grense per stisegment: 255 minus temp-filens tillegg. */
export const MAKS_SEGMENT_BYTES = 211;

export const EXIT_OK = 0;
export const EXIT_AVVIST = 1;
export const EXIT_BRUK = 2;
export const EXIT_FEILET = 3;

export type FnrType = "fødselsnummer" | "D-nummer" | "H-nummer";
export type FunnType = FnrType | "organisasjonsnummer" | "e-post" | "NAVident";

export interface Funn {
  /** Første linje verdien står på. */
  linje: number;
  type: FunnType;
  maskert: string;
  /** e-post og NAVident — avvises bare uten --tillat-ident. */
  ident: boolean;
  /** Hvor mange ganger samme verdi står i teksten. */
  antall: number;
}

/** Alle tegn unntatt de to siste blir `*`. */
export function masker(verdi: string): string {
  const v = verdi.replace(/\s/g, "");
  if (v.length <= 2) return "*".repeat(v.length);
  return "*".repeat(v.length - 2) + v.slice(-2);
}

// ── Normalisering ────────────────────────────────────────────────

const NAVNGITTE_ENTITETER: Record<string, string> = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", numsp: " ", puncsp: " ", hairsp: " ", emsp13: " ", emsp14: " ",
  MediumSpace: " ", NonBreakingSpace: " ", shy: "", zwj: "", zwnj: "", ZeroWidthSpace: "", NoBreak: "", lrm: "", rlm: "",
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", period: ".", hyphen: "-", dash: "-", ndash: "-", mdash: "-",
  minus: "-", commat: "@", colon: ":", sol: "/", verbar: "|", vert: "|", lowbar: "_", num: "#", ast: "*", midast: "*",
};

/**
 * HTML-entiteter: numeriske (`;` valgfri), navngitte (`;` påkrevd) og de
 * eldre navnene nettleseren også leser uten `;` (`&nbsp12345` er et hardt
 * mellomrom foran 12345).
 */
export function dekodEntiteter(s: string): string {
  return s.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([A-Za-z][A-Za-z0-9]{1,31});|(nbsp|shy|amp|lt|gt|quot))/g, (hel, des, heks, navn, eldre) => {
    if (eldre !== undefined) return NAVNGITTE_ENTITETER[eldre]!;
    if (navn !== undefined) return NAVNGITTE_ENTITETER[navn] ?? hel;
    const kp = des !== undefined ? Number(des) : parseInt(heks, 16);
    if (kp > 0x10ffff || (kp >= 0xd800 && kp <= 0xdfff)) return "";
    if (kp < 0x20 || (kp >= 0x7f && kp <= 0x9f)) return " ";
    return String.fromCodePoint(kp);
  });
}

/**
 * Tegn som vises som ingenting. Hangul-fyllene (U+115F, U+1160, U+3164,
 * U+FFA0) er bokstaver for Unicode, og ville ellers stoppet projeksjonen, som
 * ikke slår sammen over bokstaver. Listen brukes etter NFKC, som gjør U+FFA0
 * og U+3164 til U+1160.
 */
const USYNLIGE = /[\u00ad\u115f\u1160\u180e\u200b-\u200f\u2060-\u2064\u3164\ufeff\uffa0]/g;
const BINDESTREKER = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;

/**
 * Én linje slik skanneren leser den: entiteter dekodet, NFKC (fullbredde-sifre
 * blir ASCII), usynlige tegn og myk bindestrek fjernet, alle mellomrom til
 * vanlig mellomrom og bindestrekvarianter til `-`.
 */
export function normaliserLinje(linje: string): string {
  return dekodEntiteter(linje)
    .normalize("NFKC")
    .replace(USYNLIGE, "")
    .replace(/[\p{Zs}\t]/gu, " ")
    .replace(BINDESTREKER, "-");
}

// ── Kontrollsifre ────────────────────────────────────────────────

function mod11(sifre: number[], vekter: number[]): number | null {
  const sum = vekter.reduce((acc, w, i) => acc + w * sifre[i]!, 0);
  const k = 11 - (sum % 11);
  if (k === 11) return 0;
  if (k === 10) return null;
  return k;
}

const K1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const K2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Begge kontrollsifrene i et 11-sifret nummer stemmer. */
export function gyldigKontrollsiffer11(nr: string): boolean {
  if (!/^\d{11}$/.test(nr)) return false;
  const d = [...nr].map(Number);
  const k1 = mod11(d, K1);
  if (k1 === null || k1 !== d[9]) return false;
  const k2 = mod11(d, K2);
  return k2 !== null && k2 === d[10];
}

const DAGER_I_MÅNED = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Fødselsnummer, D-nummer (dag + 40), H-nummer (måned + 40) eller ingen av
 * delene. H-nummer tildeles ekte personer og flagges; måned + 80 er syntetiske
 * testpersoner og flagges ikke. 29. februar er alltid tillatt, fordi århundret
 * ikke avledes — en litt for vid datosjekk avviser heller for mye.
 */
export function klassifiser11(nr: string): FnrType | null {
  if (!gyldigKontrollsiffer11(nr)) return null;
  let dag = Number(nr.slice(0, 2));
  let måned = Number(nr.slice(2, 4));
  let type: FnrType = "fødselsnummer";
  if (dag > 40) {
    dag -= 40;
    type = "D-nummer";
  }
  if (måned > 40 && måned <= 52) {
    måned -= 40;
    if (type === "fødselsnummer") type = "H-nummer";
  }
  if (måned < 1 || måned > 12) return null;
  if (dag < 1 || dag > DAGER_I_MÅNED[måned - 1]!) return null;
  return type;
}

const ORG_VEKTER = [3, 2, 7, 6, 5, 4, 3, 2];

/** Kontrollsifferet i et 9-sifret organisasjonsnummer stemmer (starter på 8 eller 9). */
export function gyldigOrgnr(nr: string): boolean {
  if (!/^[89]\d{8}$/.test(nr)) return false;
  const d = [...nr].map(Number);
  const k = mod11(d, ORG_VEKTER);
  return k !== null && k === d[8];
}

// `\s*(?:-\s*)?`, ikke `\s*-?\s*`: to `\s*` etter hverandre gir kvadratisk
// tilbakesporing på en lang rekke mellomrom (målt 2,3 s på 64k).
const ORG_ORD = /org(?:anisasjons)?\.?\s*(?:-\s*)?(?:nr|nummer)|orgnr|\borgnum|(?:virksomhets|foretaks|enhets)\.?\s*(?:-\s*)?(?:nr|nummer)/i;

/**
 * Når et gyldig 9-sifret tall regnes som et organisasjonsnummer. Et tall med
 * riktig kontrollsiffer alene er for vanlig (omtrent hvert ellevte tall), så
 * det kreves i tillegg ett av:
 *   - et stikkord (orgnr, organisasjons-, virksomhets-, foretaks-, enhetsnummer),
 *   - en tabellrad (`|` først) eller en HTML-celle (`<td>`/`<th>`),
 *   - en linje inne i en kodeblokk,
 *   - en JSON-, YAML- eller nøkkel-verdi-linje (`"felt": …`, `felt: …`, `- 9…`).
 */
export function erDatakontekst(linje: string, iKodeblokk: boolean): boolean {
  if (iKodeblokk) return true;
  if (ORG_ORD.test(linje)) return true;
  const t = linje.trim();
  if (t.startsWith("|")) return true;
  if (/<t[dh][\s>]/i.test(t)) return true;
  if (/["'][^"']*["']\s*:/.test(t)) return true;
  if (/^["']?[\p{L}_][\p{L}\p{N}_.-]*["']?\s*[:=]\s*["']?\d/u.test(t)) return true;
  if (/^-\s+["']?\d/.test(t)) return true;
  return false;
}

// ── Skanner ──────────────────────────────────────────────────────

const RE_9 = /(?<!\d)(\d{3})[ .]?(\d{3})[ .]?(\d{3})(?!\d)/g;
/** Stor bokstav + 6 sifre. En git-SHA er små bokstaver og treffer ikke. */
const RE_NAVIDENT = /(?<![A-Za-z0-9])[A-Z]\d{6}(?![A-Za-z0-9])/g;
/** Tegn mellom sifergrupper som projeksjonen slår sammen over. */
const MAKS_MELLOMROM_PROJEKSJON = 5;
/** En rekke blanke, `|` og HTML-tagger. Hver rekke teller som ett skilletegn. */
const SKILLEREKKE = /(?:\s|\||<[^<>]{0,200}>)+/g;

/**
 * 11-sifrede kandidater fra linjens sifre alene. Hver rekke av blanke, `|` og
 * HTML-tagger telles først som ett tegn. Sifergrupper skilt av høyst
 * MAKS_MELLOMROM_PROJEKSJON tegn uten bokstaver slås så sammen, og hver
 * sammenhengende rekke grupper som til sammen har nøyaktig 11 sifre, blir en
 * kandidat. Det dekker `15038512345`, `150385 12345`, `150385.12345`,
 * `15.03.85 12345`, `| 150385     | 12345 |` (prettier-justert),
 * `**150385**12345` og `<td>…</td><td>…</td>`, men ikke `150385 og 12345`.
 */
export function sifferkandidater(linje: string): string[] {
  const uten = linje.replace(SKILLEREKKE, " ");
  const ut: string[] = [];
  let gruppe: string[] = [];
  let forrigeSlutt = -1;
  const tøm = () => {
    for (let i = 0; i < gruppe.length; i++) {
      let s = "";
      for (let j = i; j < gruppe.length && s.length < 11; j++) {
        s += gruppe[j];
        if (s.length === 11) ut.push(s);
      }
    }
    gruppe = [];
  };
  for (const m of uten.matchAll(/\d+/g)) {
    if (forrigeSlutt >= 0) {
      const mellom = uten.slice(forrigeSlutt, m.index);
      if (mellom.length > MAKS_MELLOMROM_PROJEKSJON || /\p{L}/u.test(mellom)) tøm();
    }
    gruppe.push(m[0]);
    forrigeSlutt = m.index! + m[0].length;
  }
  tøm();
  return ut;
}

function erLokaltegn(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
}
function erDomenetegn(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45;
}

/**
 * E-postadresser, i lineær tid: bare posisjoner med `@` undersøkes, og hvert
 * tegn leses høyst et par ganger. Et regex av typen `[…]+@` prøver hver
 * startposisjon på en lang linje uten `@` og er kvadratisk.
 */
export function finnEpost(linje: string): string[] {
  const ut: string[] = [];
  let fra = 0;
  for (;;) {
    const at = linje.indexOf("@", fra);
    if (at < 0) return ut;
    fra = at + 1;
    let v = at;
    while (v > 0 && erLokaltegn(linje.charCodeAt(v - 1))) v--;
    if (v === at) continue;
    let h = at + 1;
    while (h < linje.length && erDomenetegn(linje.charCodeAt(h))) h++;
    const domene = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(linje.slice(at + 1, h));
    if (domene) ut.push(`${linje.slice(v, at)}@${domene[0]}`);
  }
}

/** Linjen består bare av tabellceller: tagger, sifre, blanke og `| . -`, og minst én tagg. */
function erCellelinje(linje: string): boolean {
  return /<[^<>]{0,200}>/.test(linje) && /\d/.test(linje) && /^[\d\s|.-]*$/.test(linje.replace(/<[^<>]{0,200}>/g, ""));
}

/** Kodeblokk-gjerde: tegn og lengde, så ``` inne i en ````-blokk ikke lukker den. */
function gjerde(linje: string): { tegn: string; lengde: number; resten: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(linje);
  if (!m) return null;
  return { tegn: m[1]![0]!, lengde: m[1]!.length, resten: m[2]! };
}

/** Skanner tekst linje for linje. Samme type + verdi rapporteres én gang, med antall. */
export function skannTekst(tekst: string): Funn[] {
  const funn = new Map<string, Funn>();
  const legg = (linje: number, type: FunnType, verdi: string, ident: boolean) => {
    const nøkkel = `${type}\u0000${verdi}`;
    const f = funn.get(nøkkel);
    if (f) f.antall++;
    else funn.set(nøkkel, { linje, type, maskert: masker(verdi), ident, antall: 1 });
  };
  let åpen: { tegn: string; lengde: number } | null = null;
  const linjer = tekst.split(/\r?\n/);
  // HTML med én celle per linje (`<td>150385</td>` / `<td>12345</td>`): en
  // rekke slike linjer projiseres også samlet. Bare kandidater ingen enkelt
  // linje i rekken ga, telles der, så antallet ikke dobles.
  let celler: { start: number; tekst: string[]; enkelt: Set<string> } | null = null;
  const tømCeller = () => {
    if (celler && celler.tekst.length > 1) {
      for (const tall of new Set(sifferkandidater(celler.tekst.join(" ")))) {
        if (celler.enkelt.has(tall)) continue;
        const type = klassifiser11(tall);
        if (type) legg(celler.start, type, tall, false);
      }
    }
    celler = null;
  };
  for (let i = 0; i < linjer.length; i++) {
    const rå = linjer[i]!;
    const nr = i + 1;
    // Gjerdelinjen skannes selv også (info-strengen kan bære et nummer).
    const varÅpen = åpen !== null;
    const g = gjerde(rå);
    if (g && !åpen && !(g.tegn === "`" && g.resten.includes("`"))) åpen = g;
    else if (g && åpen && g.tegn === åpen.tegn && g.lengde >= åpen.lengde && g.resten.trim() === "") åpen = null;
    const iKodeblokk = varÅpen && åpen !== null;
    const linje = normaliserLinje(rå);
    const enkelt = new Set(sifferkandidater(linje));
    for (const tall of enkelt) {
      const type = klassifiser11(tall);
      if (type) legg(nr, type, tall, false);
    }
    if (erCellelinje(linje)) {
      celler ??= { start: nr, tekst: [], enkelt: new Set() };
      celler.tekst.push(linje);
      for (const t of enkelt) celler.enkelt.add(t);
    } else tømCeller();
    if (erDatakontekst(linje, iKodeblokk)) {
      const ni = new Set<string>();
      for (const m of linje.matchAll(RE_9)) ni.add(m[1]! + m[2]! + m[3]!);
      for (const tall of ni) if (gyldigOrgnr(tall)) legg(nr, "organisasjonsnummer", tall, false);
    }
    for (const e of finnEpost(linje)) legg(nr, "e-post", e, true);
    for (const m of linje.matchAll(RE_NAVIDENT)) legg(nr, "NAVident", m[0], true);
  }
  tømCeller();
  return [...funn.values()];
}

/**
 * Siden er culled: `signal: none` i frontmatter (store/små bokstaver, blanke
 * linjer foran tåles), eller — bare i en .html-side — `<meta name="wiki-signal"
 * content="none">`, muninns HTML-form. En .md-side som omtaler meta-taggen i
 * teksten, er ikke culled.
 */
export function harSignalNone(tekst: string, erHtml = false): boolean {
  const t = tekst.replace(/^\ufeff/, "");
  const fm = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (fm && /^[ \t]*signal[ \t]*:[ \t]*["']?none["']?[ \t]*(#.*)?$/im.test(fm[1]!)) return true;
  if (!erHtml) return false;
  for (const m of t.matchAll(/<meta\b[^<>]{0,1000}>/gi)) {
    const tagg = m[0];
    if (/\bname\s*=\s*["']?wiki-signal(?=["'\s/>])/i.test(tagg) && /\bcontent\s*=\s*["']?\s*none\s*(?=["'\s/>])/i.test(tagg)) return true;
  }
  return false;
}

// ── Stier ────────────────────────────────────────────────────────

/** Speilets kontrolltegn (C0, DEL, C1, U+2028/9, bidi) + LRM/RLM/ALM. */
const KONTROLLTEGN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const JOKERTEGN = /[[\]*?]/;

/** Stiregler som gjelder både opplasting og sletting. */
function sjekkStiform(rel: string): string | null {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return "ugyldig sti";
  if (KONTROLLTEGN.test(rel)) return "stien har kontrolltegn eller retningstegn";
  if (JOKERTEGN.test(rel)) return "stien har et jokertegn ([ ] * ?) som gcloud tolker som mønster";
  if (/#\d+$/.test(rel)) return "stien slutter på #<sifre>, som gcloud leser som en objektversjon";
  const deler = rel.normalize("NFC").split("/");
  if (deler.some((d) => d === "" || d === "." || d === "..")) return "stien peker ut av wiki-roten";
  if (deler.some((d) => Buffer.byteLength(d) > MAKS_SEGMENT_BYTES)) return `et stisegment er lengre enn ${MAKS_SEGMENT_BYTES} byte`;
  return null;
}

/**
 * Avslag på grunn av sti eller filtype, eller null når stien er tillatt.
 * `rel` er posix-relativ til wiki-roten.
 */
export function sjekkSti(rel: string, navngitt = false): string | null {
  const form = sjekkStiform(rel);
  if (form) return form;
  const nfc = rel.normalize("NFC");
  if (nfc === LESER_KONFIG) return null;
  if (nfc.split("/").some((d) => d.startsWith("."))) return "skjult fil eller mappe";
  const ext = path.posix.extname(nfc).toLowerCase();
  if (datatype(nfc) !== null) {
    return navngitt ? null : `filtypen ${ext} publiseres bare sammen med en side som viser den (csv=, sql= eller src=)`;
  }
  if (UTTREKK_ENDELSER.has(ext)) return `filtypen ${ext} er et uttrekk og publiseres aldri`;
  if (BILDE_ENDELSER.has(ext)) return `bilder (${ext}) publiseres ikke — speilet viser bare sider`;
  if (!SIDE_ENDELSER.has(ext)) return `filtypen ${ext || "(ingen)"} er ikke tillatt`;
  return null;
}

// ── Datafiler en side viser ──────────────────────────────────────
//
// En port av muninns regel for hvilke filer leseren leser for en side
// (`loadPageFiles` i src/wiki/page-files.ts): `<Query csv= sql=>`,
// `<CaseBoard src=>` og `<DeltaTable src=>`, utenom frontmatter og
// kodeblokker, med ref-en relativ til sidens mappe. Testen
// publiser-felles-wiki.datafiler.test.ts kjører den mot
// publiser-felles-wiki.datafiler.cases.json, som er en kopi av muninns
// src/wiki/page-file-refs.cases.json; muninn tester sin egen regel mot samme fil.
//
// Porten leser tagger linje for linje og ser ikke hele markdown-treet. Den skal
// finne minst det muninn leser: en fil porten ikke finner, mangler i poden. Den
// finner derfor også tagger muninn ikke tolker som komponent, for eksempel en
// komponent mer enn tre nivåer ned, en lukketagg som krysser en beholder, eller
// en beholder på samme linje som muninn ikke kjenner. Da lastes en skannet fil
// opp som siden ikke viser.

export type Datatype = "csv" | "sql" | "yaml";
const DATATYPE_ENDELSER: Record<Datatype, readonly string[]> = { csv: [".csv"], sql: [".sql"], yaml: [".yaml", ".yml"] };
export const DATA_ENDELSER = new Set(Object.values(DATATYPE_ENDELSER).flat());

/** Endelsen fra siste `.` i siste segment, små bokstaver; ingen for en punktfil. */
function endelse(p: string): string {
  const navn = p.slice(p.lastIndexOf("/") + 1);
  const punkt = navn.lastIndexOf(".");
  return punkt > 0 ? navn.slice(punkt).toLowerCase() : "";
}

/** Datatypen endelsen sier, eller null. */
export function datatype(p: string): Datatype | null {
  const e = endelse(p);
  return (Object.keys(DATATYPE_ENDELSER) as Datatype[]).find((t) => DATATYPE_ENDELSER[t].includes(e)) ?? null;
}

export interface NavngittDatafil {
  /** Attributtverdien slik siden skriver den (trimmet). */
  ref: string;
  /** Typene attributtene som navngir ref-en, leser den som. */
  typer: Datatype[];
  /** `ugyldig`: absolutt sti, `\`, NUL, stasjon, punktsegment eller node_modules. `filtype`: feil endelse for attributtet. */
  utfall: "ok" | "ugyldig" | "filtype";
  /** Stien under wiki-roten, eller null når utfallet ikke er ok eller `..` går over roten. */
  rel: string | null;
}

const DATA_KOMPONENTER = new Set(["Query", "CaseBoard", "DeltaTable"]);
/** COMPONENT_OPEN_RE i muninn: attributter bare med doble anførselstegn. */
const ÅPNE_TAGG = /^<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(\/?)>(.*)$/;
const ATTRIBUTT = /([A-Za-z][\w-]*)="([^"]*)"/g;
const GJERDE = /^( {0,3})(`{3,})(.*)$/;
/** En åpningstagg på starten av linjen, med attributter i doble eller enkle anførselstegn. */
const BEHOLDER = /^<([A-Za-z][A-Za-z0-9]*)(?:\s+[A-Za-z][\w-]*(?:="[^"]*"|='[^']*')?)*\s*>/;

/**
 * Linjen uten beholdere rundt en datakomponent på samme linje
 * (`<Callout tone="info"><Query … /></Callout>`): åpningstagger foran fjernes,
 * og lukketaggene for de samme navnene bakerst. muninn leser slike linjer.
 * Hvilke beholdere og om lukketaggene står i riktig rekkefølge, sjekkes ikke.
 */
function utenBeholdere(linje: string): string {
  const navn = new Set<string>();
  let t = linje;
  for (let m = BEHOLDER.exec(t); m && !DATA_KOMPONENTER.has(m[1]!); m = BEHOLDER.exec(t)) {
    navn.add(m[1]!);
    t = t.slice(m[0].length).trimStart();
  }
  for (let fjernet = navn.size > 0; fjernet; ) {
    fjernet = false;
    for (const n of navn) {
      if (t.endsWith(`</${n}>`)) {
        t = t.slice(0, -`</${n}>`.length).trimEnd();
        fjernet = true;
      }
    }
  }
  return t;
}

/** splitFrontmatter i muninn: bare når teksten starter med `---`. */
function utenFrontmatter(tekst: string): string {
  if (!tekst.startsWith("---")) return tekst;
  const slutt = tekst.indexOf("\n---", 3);
  if (slutt === -1) return tekst;
  const etter = tekst.indexOf("\n", slutt + 1);
  return etter === -1 ? "" : tekst.slice(etter + 1);
}

/**
 * Linjene med kodeblokkene byttet mot tomme linjer. Samme gjerderegel som
 * muninn: bare backticks, høyst tre mellomrom foran, en backtick i
 * info-strengen gjør linjen til tekst, lukkingen er minst like lang og har
 * ingen tekst etter seg, og en blokk som aldri lukkes, er vanlig tekst.
 */
function utenKodeblokker(linjer: string[]): string[] {
  const ut: string[] = [];
  let i = 0;
  while (i < linjer.length) {
    const å = GJERDE.exec(linjer[i]!);
    if (!å || å[3]!.includes("`")) {
      ut.push(linjer[i]!);
      i++;
      continue;
    }
    let lukk = -1;
    for (let j = i + 1; j < linjer.length; j++) {
      const l = GJERDE.exec(linjer[j]!);
      if (l && l[2]!.length >= å[2]!.length && l[3]!.trim() === "") {
        lukk = j;
        break;
      }
    }
    if (lukk === -1) {
      ut.push(linjer[i]!);
      i++;
      continue;
    }
    ut.push("");
    i = lukk + 1;
  }
  return ut;
}

/** Taggen på linje `i` er en lukket komponent etter muninns regel (selvlukkende, lukket på linjen, eller med en egen lukkelinje). */
function erLukket(linjer: string[], i: number, navn: string, selvlukkende: boolean, resten: string): boolean {
  const lukk = `</${navn}>`;
  if (selvlukkende) return resten.trim() === "";
  const på = resten.indexOf(lukk);
  if (på !== -1) return resten.slice(på + lukk.length).trim() === "";
  if (resten.trim() !== "") return false;
  let dybde = 1;
  for (let j = i + 1; j < linjer.length; j++) {
    const t = linjer[j]!.trim();
    if (t === lukk) {
      if (--dybde === 0) return true;
      continue;
    }
    const m = ÅPNE_TAGG.exec(t);
    if (m && m[1] === navn && m[3] !== "/" && !m[4]!.includes(lukk)) dybde++;
  }
  return false;
}

/** checkPageFileRef i muninn: den leksikalske sjekken før noen fil åpnes. */
function sjekkRef(ref: string, typer: Iterable<Datatype>): NavngittDatafil["utfall"] {
  if (!ref || ref.startsWith("/") || ref.includes("\\") || ref.includes("\0") || /^[A-Za-z]:/.test(ref)) return "ugyldig";
  if (ref.split("/").some((d) => d !== "." && d !== ".." && (d.startsWith(".") || d === "node_modules"))) return "ugyldig";
  const t = datatype(ref);
  return t !== null && [...typer].includes(t) ? "ok" : "filtype";
}

/** resolveEmbedRelPath i muninn: null når `..` går over roten, også om stien kommer tilbake inn. */
export function løsRef(sideRel: string, ref: string): string | null {
  const deler = sideRel.includes("/") ? sideRel.slice(0, sideRel.lastIndexOf("/")).split("/") : [];
  for (const d of ref.split("/")) {
    if (d === "" || d === ".") continue;
    if (d === "..") {
      if (deler.length === 0) return null;
      deler.pop();
      continue;
    }
    deler.push(d);
  }
  return deler.join("/");
}

/** Datafilene siden `sideRel` (posix, relativ til wiki-roten) viser, i kilderekkefølge og uten duplikater. */
export function navngitteDatafiler(sideRel: string, tekst: string): NavngittDatafil[] {
  const linjer = utenKodeblokker(utenFrontmatter(tekst).replace(/\r\n/g, "\n").split("\n"));
  const funnet = new Map<string, Set<Datatype>>();
  const legg = (ref: string | undefined, type: Datatype) => {
    const r = (ref ?? "").trim();
    if (r) funnet.set(r, (funnet.get(r) ?? new Set()).add(type));
  };
  linjer.forEach((linje, i) => {
    const m = ÅPNE_TAGG.exec(utenBeholdere(linje.trim()));
    if (!m || !DATA_KOMPONENTER.has(m[1]!)) return;
    if (!erLukket(linjer, i, m[1]!, m[3] === "/", m[4]!)) return;
    const attr: Record<string, string> = {};
    for (const a of m[2]!.matchAll(ATTRIBUTT)) attr[a[1]!] = a[2]!;
    if (m[1] === "Query") {
      legg(attr.csv, "csv");
      legg(attr.sql, "sql");
    } else legg(attr.src, m[1] === "CaseBoard" ? "yaml" : "csv");
  });
  return [...funnet].map(([ref, typer]) => {
    const utfall = sjekkRef(ref, typer);
    return { ref, typer: [...typer].sort(), utfall, rel: utfall === "ok" ? løsRef(sideRel, ref) : null };
  });
}

// ── CSV: kolonner med NAVident ───────────────────────────────────

interface Celle {
  tekst: string;
  sitert: boolean;
}

interface Post {
  celler: Celle[];
  /** Linjeskiftet posten slutter med i kildefilen; tomt for en siste post uten linjeskift. */
  slutt: string;
}

/**
 * CSV etter RFC 4180: felt i anførselstegn kan ha komma, `""` og linjeskift.
 * Alle poster beholdes, også tomme linjer, med sitt eget linjeskift, så kopien
 * får samme linjer minus kolonnene. Gir en feil når et anførselstegn aldri
 * lukkes, eller når tekst følger etter et avsluttende anførselstegn (`"a";"b"`,
 * `"x"y`); muninns `parseCsv` limer da teksten inn i cellen.
 */
function lesCsv(tekst: string): { poster: Post[] } | { feil: string } {
  const poster: Post[] = [];
  let post: Celle[] = [];
  let felt = "";
  let sitert = false;
  let iSitat = false;
  let i = 0;
  const nyCelle = () => {
    post.push({ tekst: felt, sitert });
    felt = "";
    sitert = false;
  };
  const nyPost = (slutt: string) => {
    nyCelle();
    poster.push({ celler: post, slutt });
    post = [];
  };
  while (i < tekst.length) {
    const c = tekst[i]!;
    if (iSitat) {
      if (c === '"' && tekst[i + 1] === '"') {
        felt += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        iSitat = false;
        const neste = tekst[i + 1];
        if (neste !== undefined && neste !== "," && neste !== "\r" && neste !== "\n") {
          return { feil: `rad ${poster.length + 1} har tekst etter et avsluttende anførselstegn` };
        }
      } else felt += c;
      i++;
      continue;
    }
    if (c === '"' && felt === "" && !sitert) {
      iSitat = true;
      sitert = true;
    } else if (c === ",") nyCelle();
    else if (c === "\r" && tekst[i + 1] === "\n") {
      nyPost("\r\n");
      i++;
    } else if (c === "\r") nyPost("\r");
    else if (c === "\n") nyPost("\n");
    else felt += c;
    i++;
  }
  if (iSitat) return { feil: "et anførselstegn lukkes aldri" };
  if (felt !== "" || post.length > 0 || sitert) nyPost("");
  return { poster };
}

/** En tom linje: én tom celle uten anførselstegn. Muninns leser hopper over den. */
function erTom(p: Post): boolean {
  return p.celler.length === 1 && p.celler[0]!.tekst === "" && !p.celler[0]!.sitert;
}

function skrivCelle(c: Celle): string {
  return c.sitert || /[",\r\n]/.test(c.tekst) ? `"${c.tekst.replace(/"/g, '""')}"` : c.tekst;
}

export interface FjernetKolonne {
  /** Overskriften, eller `kolonne nr. N` når overskriften selv har et funn. */
  navn: string;
  /** Rader (overskriften medregnet) der skanneren fant en NAVident i kolonnen. */
  rader: number;
}

const BARE_KOMMADELT = "bare kommadelt, rektangulær CSV kan renses for kolonner med NAVident";

/**
 * Kopien av en CSV uten kolonnene der skanneren finner en NAVident, eller en
 * grunn til at det ikke går. Hver celle skannes for seg; en kolonne fjernes i
 * alle poster. Er ingen kolonne rammet, er teksten uendret.
 *
 * Kolonner fjernes bare fra en fil som beviselig er kommadelt og rektangulær;
 * alt annet avvises:
 * - et anførselstegn som aldri lukkes, eller tekst etter et avsluttende
 *   anførselstegn før neste komma eller linjeskift;
 * - et semikolon eller en tabulator i en overskriftscelle uten anførselstegn;
 * - en overskrift med færre enn to kolonner;
 * - en post som ikke er tom og har et annet antall kolonner enn overskriften;
 * - ingen kolonner igjen etter at kolonnene med NAVident er fjernet.
 * Overskriften er første post som ikke er en tom linje. Tomme linjer er lov hvor
 * som helst og beholdes. Et semikolon i en datarad avvises ikke.
 */
export function fjernIdentKolonner(tekst: string): { tekst: string; fjernet: FjernetKolonne[] } | string {
  const lest = lesCsv(tekst);
  if ("feil" in lest) return `${lest.feil}; ${BARE_KOMMADELT}`;
  const poster = lest.poster;
  const treff = new Map<number, number>();
  for (const post of poster) {
    post.celler.forEach((celle, k) => {
      if (skannTekst(celle.tekst).some((f) => f.type === "NAVident")) treff.set(k, (treff.get(k) ?? 0) + 1);
    });
  }
  if (treff.size === 0) return { tekst, fjernet: [] };
  const overskrift = poster.find((p) => !erTom(p))?.celler ?? [];
  // Et komma i et felt (desimalkomma) gir en semikolondelt fil flere kolonner, så bredden alene avslører den ikke.
  const usitert = overskrift.filter((c) => !c.sitert).map((c) => c.tekst).join("");
  const skilletegn = usitert.includes(";") ? "semikolon" : usitert.includes("\t") ? "tabulator" : null;
  if (skilletegn) return `overskriften er delt med ${skilletegn}; ${BARE_KOMMADELT}`;
  const bredde = overskrift.length;
  if (bredde < 2) return `overskriften har færre enn to kolonner; ${BARE_KOMMADELT}`;
  for (let r = 0; r < poster.length; r++) {
    const p = poster[r]!;
    if (!erTom(p) && p.celler.length !== bredde) {
      return `rad ${r + 1} har ${p.celler.length} kolonner, overskriften har ${bredde}; ${BARE_KOMMADELT}`;
    }
  }
  if (treff.size >= bredde) return `det blir ingen kolonner igjen når kolonnene med NAVident fjernes; ${BARE_KOMMADELT}`;
  const fjernet = [...treff.keys()].sort((a, b) => a - b).map((k) => {
    const navn = overskrift[k]?.tekst ?? "";
    return { navn: navn && skannTekst(navn).length === 0 ? synligeTegn(navn) : `kolonne nr. ${k + 1}`, rader: treff.get(k)! };
  });
  return { tekst: poster.map((p) => p.celler.filter((_, k) => !treff.has(k)).map(skrivCelle).join(",") + p.slutt).join(""), fjernet };
}

/** Lokale bildestier en side viser (markdown, `<img src>`, `src=`). */
export function refererteBilder(tekst: string): string[] {
  const ut = new Set<string>();
  const kandidater: string[] = [];
  for (const m of tekst.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g)) kandidater.push((m[1] ?? m[2])!);
  for (const m of tekst.matchAll(/\bsrc\s*=\s*\{?\s*["']([^"']+)["']/g)) kandidater.push(m[1]!);
  for (const k of kandidater) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(k) || k.startsWith("/") || k.startsWith("#")) continue;
    if (BILDE_ENDELSER.has(path.posix.extname(k.split(/[?#]/)[0]!).toLowerCase())) ut.add(k);
  }
  return [...ut];
}

/** Nøkkelen speilet sammenligner navn på: små bokstaver + NFC. */
export function kollisjonsnøkkel(navn: string): string {
  return navn.normalize("NFC").toLowerCase();
}

const KONTROLLTEGN_ALLE = new RegExp(KONTROLLTEGN.source, "g");

/** Kontroll- og retningstegn skrevet som `\u{…}`, så de ikke når terminalen. */
export function synligeTegn(s: string): string {
  return s.replace(KONTROLLTEGN_ALLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** Stien slik den kan skrives ut: hel med kontrolltegn synlige, eller skjult når den har et funn. */
export function visningsnavn(rel: string, nr?: number): string {
  const funn = skannTekst(rel);
  if (funn.length === 0) return synligeTegn(rel);
  return `[skjult sti${nr !== undefined ? ` nr. ${nr}` : ""}: inneholder ${[...new Set(funn.map((f) => f.type))].join(", ")}]`;
}

export interface Vurdering {
  rel: string;
  /** Objektnavnet i bøtta: `rel` i NFC. */
  objekt: string;
  /** Det som skrives ut i stedet for stien. */
  visning: string;
  avslag: string[];
  advarsler: string[];
  /** Kolonner fjernet fra en CSV-kopi (bare datafiler). */
  fjernet: FjernetKolonne[];
  /** Byteene som ble skannet, og som lastes opp. */
  bytes?: Uint8Array;
}

/**
 * UTF-16 eller UTF-32 (byte-rekkefølgemerke eller NUL-byte), eller null. En
 * slik fil dekodet som UTF-8 har en NUL mellom hvert tegn, og da treffer
 * verken e-post, NAVident eller stikkordene for organisasjonsnummer.
 */
function ikkeUtf8(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) return "filen er UTF-32";
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return "filen er UTF-16 eller UTF-32";
  if (b.includes(0)) return "filen har NUL-byte (trolig UTF-16 uten merke)";
  return null;
}

/**
 * Vurderer én fil på disk. `abs` må ligge under roten; symlenker avvises.
 * `datafil`: filen er navngitt av en side (se `navngitteDatafiler`). Da gjelder
 * datagrensen, `--tillat-ident` gjelder ikke, og en CSV får kolonnene med
 * NAVident fjernet fra kopien, som så skannes på nytt.
 */
export function vurderFil(abs: string, rel: string, tillatIdent: boolean, nr?: number, datafil = false): Vurdering {
  const visning = visningsnavn(rel, nr);
  const v: Vurdering = { rel, objekt: rel.normalize("NFC"), visning, avslag: [], advarsler: [], fjernet: [] };
  if (datafil) tillatIdent = false;
  const maks = datafil ? MAKS_DATA_BYTES : MAKS_BYTES;
  const sti = sjekkSti(rel, datafil);
  if (sti) {
    v.avslag.push(sti);
    return v;
  }
  for (const f of skannTekst(rel)) {
    if (f.ident && tillatIdent) v.advarsler.push(`filnavnet har ${f.type} ${f.maskert} (tillatt med --tillat-ident)`);
    else v.avslag.push(`filnavnet har ${f.type} ${f.maskert}`);
  }
  // Én åpning, og alle sjekker på fildeskriptoren: en sti som sjekkes og så
  // leses på nytt, kan byttes ut (for eksempel mot en symlenke) mellom de to.
  const grense = `filen er større enn ${maks} byte og ville blitt hoppet over av speilet`;
  let fd: number;
  try {
    // O_NONBLOCK: en FIFO blokkerer ellers åpningen til noen skriver til den.
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const kode = (e as NodeJS.ErrnoException).code;
    if (kode === "ENOENT") v.avslag.push("filen finnes ikke");
    else if (kode === "ELOOP") v.avslag.push("filen er en symlenke — publiser bare vanlige filer");
    else v.avslag.push(`filen kan ikke leses (${kode ?? "ukjent feil"})`);
    return v;
  }
  let bytes: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      v.avslag.push("ikke en vanlig fil");
      return v;
    }
    if (st.size > maks) {
      v.avslag.push(grense);
      return v;
    }
    // Les én byte over grensen, så en fil som vokser etter fstat også avvises.
    const buf = Buffer.alloc(maks + 1);
    let lest = 0;
    for (let n; lest < buf.length && (n = readSync(fd, buf, lest, buf.length - lest, lest)) > 0; ) lest += n;
    bytes = buf.subarray(0, lest);
  } catch (e) {
    v.avslag.push(`filen kan ikke leses (${(e as NodeJS.ErrnoException).code ?? "ukjent feil"})`);
    return v;
  } finally {
    closeSync(fd);
  }
  if (bytes.length > maks) {
    v.avslag.push(grense);
    return v;
  }
  const koding = ikkeUtf8(bytes);
  if (koding) {
    v.avslag.push(`${koding} — speilet og leseren forventer UTF-8, og skanneren kan ikke lese filen`);
    return v;
  }
  let tekst = new TextDecoder("utf-8").decode(bytes);
  // Kolonner fjernes bare når alle funnene i kildefilen er NAVident. Ellers
  // avvises filen på funnene i kildefilen, så et fødselsnummer i en kolonne
  // som også har en NAVident, ikke forsvinner med kolonnen.
  const kildefunn = datafil && datatype(rel) === "csv" ? skannTekst(tekst) : [];
  if (kildefunn.length > 0 && kildefunn.every((f) => f.type === "NAVident")) {
    const kopi = fjernIdentKolonner(tekst);
    if (typeof kopi === "string") {
      v.avslag.push(kopi);
      return v;
    }
    v.fjernet = kopi.fjernet;
    tekst = kopi.tekst;
    bytes = Buffer.from(tekst, "utf8");
    // Sitering og linjeskift skrives på nytt, så kopien kan bli større enn kildefilen.
    if (bytes.length > maks) {
      v.avslag.push(`kopien er større enn ${maks} byte etter at kolonnene er fjernet, og ville blitt hoppet over av speilet`);
      return v;
    }
  }
  if (!datafil && harSignalNone(tekst, path.posix.extname(rel).toLowerCase() === ".html")) v.avslag.push("siden er culled (`signal: none` eller wiki-signal=none)");
  for (const f of skannTekst(tekst)) {
    const antall = f.antall > 1 ? ` (${f.antall} forekomster)` : "";
    const linje = `${visning}:${f.linje}: ${f.type} ${f.maskert}${antall}`;
    if (datafil) v.avslag.push(v.fjernet.length > 0 ? `${linje} (i kopien etter at kolonnene er fjernet)` : linje);
    else if (f.ident && tillatIdent) v.advarsler.push(`${linje} (tillatt med --tillat-ident)`);
    else v.avslag.push(f.ident ? `${linje} (bruk --tillat-ident hvis dette er med vilje)` : linje);
  }
  const bilder = !datafil && SIDE_ENDELSER.has(path.posix.extname(rel).toLowerCase()) ? refererteBilder(tekst).length : 0;
  if (bilder > 0) v.advarsler.push(`siden viser ${bilder} bilde(r); bilder publiseres ikke og vises ikke i felles-wikien`);
  v.bytes = bytes;
  return v;
}

// ── Kommandolinje ────────────────────────────────────────────────

interface Valg {
  dryRun: boolean;
  tillatIdent: boolean;
  fjern: boolean;
  ja: boolean;
  bucket?: string;
  posisjonelle: string[];
}

function lesArgs(argv: string[]): Valg | string {
  const v: Valg = { dryRun: false, tillatIdent: false, fjern: false, ja: false, posisjonelle: [] };
  let bareStier = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (bareStier) v.posisjonelle.push(a);
    else if (a === "--") bareStier = true;
    else if (a === "--dry-run") v.dryRun = true;
    else if (a === "--tillat-ident") v.tillatIdent = true;
    else if (a === "--fjern") v.fjern = true;
    else if (a === "--ja") v.ja = true;
    else if (a === "--bucket") {
      const b = argv[++i];
      if (!b) return "--bucket mangler verdi";
      v.bucket = b;
    } else if (a.startsWith("--bucket=")) v.bucket = a.slice("--bucket=".length);
    else if (a === "-h" || a === "--help") return "";
    else if (a.startsWith("-")) return `ukjent flagg: ${a}`;
    else v.posisjonelle.push(a);
  }
  if (v.fjern) {
    if (v.posisjonelle.length === 0) return "--fjern mangler relPath";
    if (v.tillatIdent) return "--tillat-ident gjelder ikke --fjern";
  } else {
    if (v.ja) return "--ja gjelder bare --fjern";
    if (v.posisjonelle.length < 2) return "mangler wiki-rot eller relPath";
  }
  return v;
}

const BRUK = [
  "Bruk: bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot> <relPath>...",
  "      bun scripts/publiser-felles-wiki.ts --fjern [--ja] [--dry-run] [--bucket <navn>] [--] <relPath>...",
].join("\n");

/** Samme form som vakten i deploy.yml: små bokstaver, sifre, bindestrek, 3–63 tegn. */
export const BØTTENAVN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface GcloudSvar {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Omgivelser {
  env: Record<string, string | undefined>;
  vars: Record<string, unknown>;
  /** null når gcloud ikke finnes. */
  gcloud: ((args: string[], stdin?: Uint8Array) => GcloudSvar) | null;
  spør: (spørsmål: string) => string | null;
  ut: (linje: string) => void;
  feil: (linje: string) => void;
}

function innholdstype(objekt: string): string {
  const ext = path.posix.extname(objekt).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".sql") return "application/sql; charset=utf-8";
  if (ext === ".yaml" || ext === ".yml") return "application/yaml; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

/**
 * Relativ posix-sti under roten, uten å løse opp symlenker, eller en grunn til
 * avslag. En symlenke i et mappeledd under roten avvises her; en symlenke som
 * selve filen avviser `vurderFil`.
 */
function relUnder(rot: string, oppgitt: string, s: string): { rel: string; abs: string } | string {
  for (const base of [rot, oppgitt]) {
    const abs = path.resolve(base, s);
    const r = path.relative(base, abs);
    if (r === "" || r.startsWith("..") || path.isAbsolute(r)) continue;
    const deler = r.split(path.sep);
    let cur = rot;
    for (let i = 0; i < deler.length - 1; i++) {
      cur = path.join(cur, deler[i]!);
      try {
        if (lstatSync(cur).isSymbolicLink()) return "stien går gjennom en symlenke";
      } catch {
        break;
      }
    }
    return { rel: deler.join("/"), abs: path.join(rot, ...deler) };
  }
  return "stien ligger utenfor wiki-roten";
}

function velgBøtte(valg: Valg, o: Omgivelser): string | undefined {
  const env = o.env.FELLES_WIKI_BUCKET?.trim();
  return valg.bucket ?? (env || undefined) ?? (typeof o.vars.felles_wiki_bucket === "string" ? o.vars.felles_wiki_bucket : undefined);
}

/**
 * Navnene på de levende objektene i bøtta, eller en feilmelding.
 *
 * `gs://<bøtte>/**`, ikke `gs://<bøtte>`: gcloud gjør en bar bøtte om til
 * `gs://<bøtte>/*`, som bare lister toppnivået, og nesten alle sider ligger i
 * en mappe. `objects list` tar med ikke-gjeldende versjoner som standard og
 * har ikke noe flagg som bare gir de levende (`--stat` endrer utdataformatet),
 * så en versjon med `noncurrent_time` hoppes over her — speilet ser den ikke.
 * En liste med en annen form enn ventet avviser hele kjøringen, i stedet for
 * å sjekke mot en liste som kanskje mangler navn.
 */
function listObjekter(bucket: string, o: Omgivelser): string[] | string {
  const r = o.gcloud!(["storage", "objects", "list", `gs://${bucket}/**`, "--format=json(name,noncurrent_time)"]);
  if (r.exitCode !== 0) return `gcloud storage objects list feilet (exit ${r.exitCode}): ${maskerGcloud(r.stderr, [])}`;
  let data: unknown;
  try {
    data = JSON.parse(r.stdout.trim() || "[]");
  } catch {
    return "kunne ikke lese objektlisten fra gcloud";
  }
  if (!Array.isArray(data)) return "objektlisten fra gcloud er ikke en liste";
  const navn: string[] = [];
  for (const x of data) {
    if (typeof x !== "object" || x === null || typeof (x as { name?: unknown }).name !== "string") {
      return "objektlisten fra gcloud har en oppføring uten navn";
    }
    if ((x as { noncurrent_time?: unknown }).noncurrent_time != null) continue;
    navn.push((x as { name: string }).name);
  }
  return navn;
}

/**
 * Siste linje av gcloud sin feilmelding, uten objektnavn med funn: hvert
 * kjente navn byttes med sin maskerte visning, og har linjen fortsatt et funn,
 * skjules hele linjen. Ber gcloud selv om `gcloud auth login`, er siste linje
 * bare halen av forklaringen, så da sier vi det rett ut i stedet.
 */
function maskerGcloud(stderr: string, navn: { objekt: string; visning: string }[]): string {
  if (/\$ gcloud auth login/.test(stderr)) {
    return "gcloud ber om innlogging: kjør `gcloud auth login`, eller velg riktig konto med `gcloud config set account`, og prøv igjen";
  }
  let linje = stderr.trim().split("\n").at(-1) ?? "";
  for (const n of navn) {
    if (skannTekst(n.objekt).length === 0) continue;
    for (const form of new Set([n.objekt, n.objekt.normalize("NFD"), encodeURIComponent(n.objekt)])) linje = linje.split(form).join(n.visning);
  }
  const funn = skannTekst(linje);
  if (funn.length > 0) return `[feilmeldingen er skjult: inneholder ${[...new Set(funn.map((f) => f.type))].join(", ")}]`;
  return linje;
}

function fjern(valg: Valg, bucket: string, o: Omgivelser): number {
  const mål: { objekt: string; visning: string }[] = [];
  let avvist = 0;
  valg.posisjonelle.forEach((rel, i) => {
    const visning = visningsnavn(rel, i + 1);
    const grunn = sjekkStiform(rel);
    if (grunn) {
      o.ut(`AVVIST  ${visning}\n    avslag: ${grunn}`);
      avvist++;
    } else mål.push({ objekt: rel, visning });
  });
  if (avvist > 0) {
    o.ut(`\n${avvist} sti(er) avvist — ingenting er slettet.`);
    return EXIT_AVVIST;
  }
  for (const m of mål) o.ut(`vil slette gs://${bucket}/${m.visning}`);
  if (mål.some((m) => [".md", ".mdx"].includes(path.posix.extname(m.objekt).toLowerCase()))) {
    o.ut("(datafilene en side viser, slettes ikke med siden — oppgi dem også, ellers blir de liggende i bøtta)");
  }
  if (valg.dryRun) {
    o.ut("\nTørrkjøring — ingenting er slettet.");
    return EXIT_OK;
  }
  if (!o.gcloud) {
    o.feil("Feil: finner ikke gcloud på PATH — ingenting er slettet");
    return EXIT_BRUK;
  }
  if (!valg.ja) {
    const svar = o.spør(`Slette ${mål.length} objekt(er) fra gs://${bucket}? [j/N]`);
    if (!svar || !/^\s*(j|ja|y|yes)\s*$/i.test(svar)) {
      o.ut("Ikke bekreftet — ingenting er slettet.");
      return EXIT_AVVIST;
    }
  }
  let feilet = 0;
  for (const m of mål) {
    o.ut(`sletter gs://${bucket}/${m.visning}`);
    const r = o.gcloud(["storage", "rm", `gs://${bucket}/${m.objekt}`]);
    if (r.exitCode === 0) o.ut(`slettet gs://${bucket}/${m.visning}`);
    else {
      feilet++;
      o.feil(`Feil: sletting av gs://${bucket}/${m.visning} feilet (exit ${r.exitCode}): ${maskerGcloud(r.stderr, [m])}`);
    }
  }
  o.ut(`\nOppsummering: ${mål.length - feilet} slettet, ${feilet} feilet. Poden fjerner sidene ved neste poll (~2 min).`);
  return feilet > 0 ? EXIT_FEILET : EXIT_OK;
}

export function kjør(argv: string[], o: Omgivelser): number {
  const valg = lesArgs(argv);
  if (typeof valg === "string") {
    if (valg) o.feil(`Feil: ${valg}`);
    o.feil(BRUK);
    return valg ? EXIT_BRUK : EXIT_OK;
  }
  const bucket = velgBøtte(valg, o);
  if (!bucket || !BØTTENAVN.test(bucket)) {
    o.feil(`Feil: ingen gyldig bøtte (fikk ${JSON.stringify(bucket ?? null)}). Bruk --bucket eller FELLES_WIKI_BUCKET.`);
    return EXIT_BRUK;
  }
  if (valg.fjern) return fjern(valg, bucket, o);

  const [rotArg, ...stier] = valg.posisjonelle;
  const ingress = typeof o.vars.ingress === "string" ? o.vars.ingress : "https://melosys-muninn.ansatt.nav.no";
  const oppgitt = path.resolve(rotArg!);
  if (!existsSync(oppgitt) || !statSync(oppgitt).isDirectory()) {
    o.feil("Feil: wiki-roten finnes ikke eller er ikke en mappe");
    return EXIT_BRUK;
  }
  const rot = realpathSync(oppgitt);

  const vurderinger: Vurdering[] = [];
  const sett = new Set<string>();
  // En datafil oppgitt alene vurderes etter sidene: den slipper bare gjennom
  // når en side i samme kjøring viser den.
  const oppgittData: { rel: string; nr: number }[] = [];
  stier.forEach((s, i) => {
    const r = relUnder(rot, oppgitt, s);
    if (typeof r === "string") {
      vurderinger.push({ rel: s, objekt: s, visning: visningsnavn(s, i + 1), avslag: [r], advarsler: [], fjernet: [] });
      return;
    }
    if (sett.has(r.rel)) return;
    sett.add(r.rel);
    if (datatype(r.rel) !== null) oppgittData.push({ rel: r.rel, nr: i + 1 });
    else vurderinger.push(vurderFil(r.abs, r.rel, valg.tillatIdent, i + 1));
  });

  // Datafilene sidene viser, i kilderekkefølge, med sidene som viser dem.
  // Sidene står før datafilene i `vurderinger`, så de lastes opp først.
  const sideneTil = new Map<Vurdering, Vurdering[]>();
  const visesAv = new Map<string, Vurdering[]>();
  for (const side of [...vurderinger]) {
    if (!side.bytes || ![".md", ".mdx"].includes(path.posix.extname(side.rel).toLowerCase())) continue;
    for (const d of navngitteDatafiler(side.rel, new TextDecoder("utf-8").decode(side.bytes))) {
      const navn = visningsnavn(d.ref);
      if (d.utfall === "ugyldig") side.advarsler.push(`${navn}: ugyldig filsti — kortet viser en feilmelding`);
      else if (d.utfall === "filtype") side.advarsler.push(`${navn}: feil filtype for attributtet — kortet viser en feilmelding`);
      else if (d.rel === null) side.advarsler.push(`${navn}: peker ut av wiki-roten — kortet viser «File not available»`);
      else visesAv.set(d.rel, [...(visesAv.get(d.rel) ?? []), side]);
    }
  }
  for (const [rel, sider] of visesAv) {
    const r = relUnder(rot, rot, rel);
    if (typeof r === "string") {
      vurderinger.push({ rel, objekt: rel.normalize("NFC"), visning: visningsnavn(rel), avslag: [r], advarsler: [], fjernet: [] });
      continue;
    }
    let finnes = true;
    try {
      lstatSync(r.abs);
    } catch {
      finnes = false;
    }
    if (!finnes) {
      for (const side of sider) side.advarsler.push(`${visningsnavn(rel)}: filen finnes ikke — kortet viser «File not available»`);
      continue;
    }
    sett.add(rel);
    const v = vurderFil(r.abs, rel, false, undefined, true);
    sideneTil.set(v, sider);
    vurderinger.push(v);
  }
  for (const d of oppgittData) {
    if (visesAv.has(d.rel)) continue;
    vurderinger.push({ rel: d.rel, objekt: d.rel.normalize("NFC"), visning: visningsnavn(d.rel, d.nr), avslag: [sjekkSti(d.rel) ?? "ukjent"], advarsler: [], fjernet: [] });
  }

  // To navn i samme kjøring som speilet ville slått sammen: avvis alle.
  const perNøkkel = new Map<string, Set<string>>();
  for (const v of vurderinger) {
    const k = kollisjonsnøkkel(v.objekt);
    perNøkkel.set(k, (perNøkkel.get(k) ?? new Set()).add(v.objekt));
  }
  for (const v of vurderinger) {
    if ((perNøkkel.get(kollisjonsnøkkel(v.objekt))?.size ?? 0) > 1) v.avslag.push("kolliderer med en annen fil i samme kjøring under små bokstaver + NFC");
  }

  // En datafil avvises når alle sidene som viser den, er avvist. Kjøres etter
  // hver sjekk som kan avvise en side.
  const sideAvvist = "siden som viser filen, er avvist";
  const avvisDatafilerUtenSide = () => {
    for (const [v, sider] of sideneTil) {
      if (sider.every((side) => side.avslag.length > 0) && !v.avslag.includes(sideAvvist)) v.avslag.push(sideAvvist);
    }
  };
  avvisDatafilerUtenSide();

  const utskriv = (v: Vurdering) => {
    o.ut(`${v.avslag.length ? "AVVIST " : "OK     "} ${v.visning}`);
    for (const a of v.avslag) o.ut(`    avslag: ${a}`);
    for (const k of v.fjernet) o.ut(`    fjernet kolonne: ${k.navn} (NAVident i ${k.rader} rad(er)) — bare fra kopien, kildefilen er uendret`);
    for (const a of v.advarsler) o.ut(`    advarsel: ${a}`);
  };

  let godkjent = vurderinger.filter((v) => v.avslag.length === 0);
  const lastetOpp: Vurdering[] = [];
  const feilet: Vurdering[] = [];

  if (godkjent.length > 0 && !valg.dryRun) {
    if (!o.gcloud) {
      vurderinger.forEach(utskriv);
      o.feil("Feil: finner ikke gcloud på PATH — ingenting er lastet opp");
      return EXIT_BRUK;
    }
    const eksisterende = listObjekter(bucket, o);
    if (typeof eksisterende === "string") {
      vurderinger.forEach(utskriv);
      o.feil(`Feil: ${eksisterende} — uten objektlisten kan kollisjoner ikke sjekkes, så ingenting er lastet opp`);
      return EXIT_BRUK;
    }
    const perEksNøkkel = new Map<string, string[]>();
    for (const n of eksisterende) perEksNøkkel.set(kollisjonsnøkkel(n), [...(perEksNøkkel.get(kollisjonsnøkkel(n)) ?? []), n]);
    for (const v of godkjent) {
      const andre = (perEksNøkkel.get(kollisjonsnøkkel(v.objekt)) ?? []).filter((n) => n !== v.objekt);
      if (andre.length > 0) {
        v.avslag.push(
          `kolliderer med eksisterende objekt ${andre.map((n) => visningsnavn(n)).join(", ")} under små bokstaver + NFC — ` +
            "fjern det gamle først med --fjern",
        );
      }
    }
    avvisDatafilerUtenSide();
    godkjent = godkjent.filter((v) => v.avslag.length === 0);
  }

  vurderinger.forEach(utskriv);

  if (valg.dryRun) {
    for (const v of godkjent) o.ut(`vil laste opp gs://${bucket}/${v.visning}`);
    if (godkjent.length > 0) o.ut("(tørrkjøring: bøtta er ikke kontaktet, så kollisjoner med eksisterende objekter er ikke sjekket)");
  } else {
    // En datafil lastes bare opp når minst én side som viser den, ble lastet opp i denne kjøringen.
    const opplastet = new Set<Vurdering>();
    for (const v of godkjent) {
      const sider = sideneTil.get(v);
      if (sider && !sider.some((side) => opplastet.has(side))) {
        feilet.push(v);
        o.feil(`Feil: ${v.visning} er ikke lastet opp: ingen side som viser den, ble lastet opp`);
        continue;
      }
      const mål = `gs://${bucket}/${v.objekt}`;
      const r = o.gcloud!(["storage", "cp", `--content-type=${innholdstype(v.objekt)}`, "-", mål], v.bytes);
      if (r.exitCode === 0) {
        lastetOpp.push(v);
        opplastet.add(v);
        o.ut(`lastet opp gs://${bucket}/${v.visning}`);
      } else {
        feilet.push(v);
        o.feil(`Feil: opplasting av ${v.visning} feilet (exit ${r.exitCode}): ${maskerGcloud(r.stderr, [v])}`);
      }
    }
  }

  const sider = (valg.dryRun ? godkjent : lastetOpp).filter((v) => SIDE_ENDELSER.has(path.posix.extname(v.objekt).toLowerCase()));
  if (sider.length > 0) {
    o.ut(valg.dryRun ? "\nTørrkjøring — ingenting er lastet opp. Adresser etter publisering:" : "\nPublisert. Speilet i poden henter endringer omtrent hvert 2. minutt:");
    // En sti med funn, også en som --tillat-ident slapp gjennom, vises maskert her som overalt ellers.
    for (const v of sider) o.ut(`  ${ingress}/wiki?wiki=melosys-felles&relPath=${v.visning === v.rel ? encodeURIComponent(v.objekt) : v.visning}`);
  }
  const avvist = vurderinger.filter((v) => v.avslag.length > 0);
  o.ut(
    valg.dryRun
      ? `\nOppsummering: ${godkjent.length} klar(e), ${avvist.length} avvist.`
      : `\nOppsummering: ${lastetOpp.length} lastet opp, ${avvist.length} avvist, ${feilet.length} feilet.`,
  );
  if (feilet.length > 0) return EXIT_FEILET;
  if (avvist.length > 0) return EXIT_AVVIST;
  return EXIT_OK;
}

function lesVars(): Record<string, unknown> {
  const fil = path.join(import.meta.dir, "..", "nais", "vars.json");
  try {
    return JSON.parse(readFileSync(fil, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const sti = Bun.which("gcloud");
  const kode = kjør(process.argv.slice(2), {
    env: process.env,
    vars: lesVars(),
    gcloud: sti
      ? (args, stdin) => {
          const r = Bun.spawnSync([sti, ...args], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
          return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        }
      : null,
    spør: (s) => prompt(s),
    ut: (l) => console.log(l),
    feil: (l) => console.error(l),
  });
  process.exit(kode);
}
