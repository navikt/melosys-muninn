#!/usr/bin/env bun
/**
 * Publiserer sider fra en lokal wiki-mappe til felles-wiki-bøtta, som
 * melosys-muninn-q2 speiler og viser skrivebeskyttet på
 * /wiki?wiki=melosys-felles. Sletter objekter med `--fjern`.
 *
 *   bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot> <relPath>...
 *   bun scripts/publiser-felles-wiki.ts --fjern [--ja] [--dry-run] [--bucket <navn>] [--] <relPath>...
 *
 * Skanneren er det eneste automatiske vernet mot personopplysninger: poden viser
 * alt i bøtta til hele teamet. Hver fil sjekkes, og en fil som feiler, lastes
 * ikke opp:
 *   - sti: speilets egne regler — bare .md, .mdx, .html og `.wiki-reader.json`
 *     på rotnivå; ingen skjulte segmenter, `..`, omvendt skråstrek, kontroll-
 *     eller retningstegn, eller segmenter over 211 byte. I tillegg avvises
 *     jokertegnene `[ ] * ?` (gcloud tolker dem som mønster), navn som slutter
 *     på `#<sifre>` (gcloud leser det som en objektversjon), symlenker og navn
 *     som kolliderer med et annet levende objekt under små bokstaver + NFC.
 *     Bilder og uttrekk (.csv .json .xlsx .txt) publiseres aldri.
 *   - størrelse: over 2 MB hopper speilet over objektet, så det avvises her.
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
 * `felles_wiki_bucket` i nais/vars-q2.json. Ingen avhengigheter utover Bun og
 * `gcloud`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const SIDE_ENDELSER = new Set([".md", ".mdx", ".html"]);
export const BILDE_ENDELSER = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp", ".ico", ".tif", ".tiff"]);
export const UTTREKK_ENDELSER = new Set([".csv", ".tsv", ".json", ".xlsx", ".xls", ".txt"]);
export const LESER_KONFIG = ".wiki-reader.json";
/** Speilet hopper over objekter større enn dette (MAX_OBJECT_BYTES i muninn). */
export const MAKS_BYTES = 2 * 1024 * 1024;
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
export function sjekkSti(rel: string): string | null {
  const form = sjekkStiform(rel);
  if (form) return form;
  const nfc = rel.normalize("NFC");
  if (nfc === LESER_KONFIG) return null;
  if (nfc.split("/").some((d) => d.startsWith("."))) return "skjult fil eller mappe";
  const ext = path.posix.extname(nfc).toLowerCase();
  if (UTTREKK_ENDELSER.has(ext)) return `filtypen ${ext} er et uttrekk og publiseres aldri`;
  if (BILDE_ENDELSER.has(ext)) return `bilder (${ext}) publiseres ikke — speilet viser bare sider`;
  if (!SIDE_ENDELSER.has(ext)) return `filtypen ${ext || "(ingen)"} er ikke tillatt`;
  return null;
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

/** Stien slik den kan skrives ut: hel, eller skjult når den har et funn. */
export function visningsnavn(rel: string, nr?: number): string {
  const funn = skannTekst(rel);
  if (funn.length === 0) return rel;
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

/** Vurderer én fil på disk. `abs` må ligge under roten; symlenker avvises. */
export function vurderFil(abs: string, rel: string, tillatIdent: boolean, nr?: number): Vurdering {
  const visning = visningsnavn(rel, nr);
  const v: Vurdering = { rel, objekt: rel.normalize("NFC"), visning, avslag: [], advarsler: [] };
  const sti = sjekkSti(rel);
  if (sti) {
    v.avslag.push(sti);
    return v;
  }
  for (const f of skannTekst(rel)) {
    if (f.ident && tillatIdent) v.advarsler.push(`filnavnet har ${f.type} ${f.maskert} (tillatt med --tillat-ident)`);
    else v.avslag.push(`filnavnet har ${f.type} ${f.maskert}`);
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    v.avslag.push("filen finnes ikke");
    return v;
  }
  if (st.isSymbolicLink()) {
    v.avslag.push("filen er en symlenke — publiser bare vanlige filer");
    return v;
  }
  if (!st.isFile()) {
    v.avslag.push("ikke en vanlig fil");
    return v;
  }
  const grense = `filen er større enn ${MAKS_BYTES} byte og ville blitt hoppet over av speilet`;
  if (st.size > MAKS_BYTES) {
    v.avslag.push(grense);
    return v;
  }
  const bytes = readFileSync(abs);
  if (bytes.length > MAKS_BYTES) {
    v.avslag.push(grense);
    return v;
  }
  const koding = ikkeUtf8(bytes);
  if (koding) {
    v.avslag.push(`${koding} — speilet og leseren forventer UTF-8, og skanneren kan ikke lese filen`);
    return v;
  }
  const tekst = new TextDecoder("utf-8").decode(bytes);
  if (harSignalNone(tekst, path.posix.extname(rel).toLowerCase() === ".html")) v.avslag.push("siden er culled (`signal: none` eller wiki-signal=none)");
  for (const f of skannTekst(tekst)) {
    const antall = f.antall > 1 ? ` (${f.antall} forekomster)` : "";
    const linje = `${visning}:${f.linje}: ${f.type} ${f.maskert}${antall}`;
    if (f.ident && tillatIdent) v.advarsler.push(`${linje} (tillatt med --tillat-ident)`);
    else v.avslag.push(f.ident ? `${linje} (bruk --tillat-ident hvis dette er med vilje)` : linje);
  }
  const bilder = SIDE_ENDELSER.has(path.posix.extname(rel).toLowerCase()) ? refererteBilder(tekst).length : 0;
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
 * skjules hele linjen.
 */
function maskerGcloud(stderr: string, navn: { objekt: string; visning: string }[]): string {
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
  const ingress = typeof o.vars.ingress_intern === "string" ? o.vars.ingress_intern : "https://melosys-muninn-q2.intern.dev.nav.no";
  const oppgitt = path.resolve(rotArg!);
  if (!existsSync(oppgitt) || !statSync(oppgitt).isDirectory()) {
    o.feil("Feil: wiki-roten finnes ikke eller er ikke en mappe");
    return EXIT_BRUK;
  }
  const rot = realpathSync(oppgitt);

  const vurderinger: Vurdering[] = [];
  const sett = new Set<string>();
  stier.forEach((s, i) => {
    const r = relUnder(rot, oppgitt, s);
    if (typeof r === "string") {
      vurderinger.push({ rel: s, objekt: s, visning: visningsnavn(s, i + 1), avslag: [r], advarsler: [] });
      return;
    }
    if (sett.has(r.rel)) return;
    sett.add(r.rel);
    vurderinger.push(vurderFil(r.abs, r.rel, valg.tillatIdent, i + 1));
  });

  // To navn i samme kjøring som speilet ville slått sammen: avvis alle.
  const perNøkkel = new Map<string, Set<string>>();
  for (const v of vurderinger) {
    const k = kollisjonsnøkkel(v.objekt);
    perNøkkel.set(k, (perNøkkel.get(k) ?? new Set()).add(v.objekt));
  }
  for (const v of vurderinger) {
    if ((perNøkkel.get(kollisjonsnøkkel(v.objekt))?.size ?? 0) > 1) v.avslag.push("kolliderer med en annen fil i samme kjøring under små bokstaver + NFC");
  }

  const utskriv = (v: Vurdering) => {
    o.ut(`${v.avslag.length ? "AVVIST " : "OK     "} ${v.visning}`);
    for (const a of v.avslag) o.ut(`    avslag: ${a}`);
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
    godkjent = godkjent.filter((v) => v.avslag.length === 0);
  }

  vurderinger.forEach(utskriv);

  if (valg.dryRun) {
    for (const v of godkjent) o.ut(`vil laste opp gs://${bucket}/${v.visning}`);
    if (godkjent.length > 0) o.ut("(tørrkjøring: bøtta er ikke kontaktet, så kollisjoner med eksisterende objekter er ikke sjekket)");
  } else {
    for (const v of godkjent) {
      const mål = `gs://${bucket}/${v.objekt}`;
      const r = o.gcloud!(["storage", "cp", `--content-type=${innholdstype(v.objekt)}`, "-", mål], v.bytes);
      if (r.exitCode === 0) {
        lastetOpp.push(v);
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
  const fil = path.join(import.meta.dir, "..", "nais", "vars-q2.json");
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
