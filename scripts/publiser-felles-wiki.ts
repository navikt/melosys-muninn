#!/usr/bin/env bun
/**
 * Publiserer sider fra en lokal wiki-mappe til felles-wiki-bøtta, som
 * melosys-muninn speiler og viser skrivebeskyttet på
 * /wiki?wiki=melosys-felles. Sletter objekter med `--fjern`.
 *
 *   bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot> <relPath>...
 *   bun scripts/publiser-felles-wiki.ts --fjern [--ja] [--dry-run] [--bucket <navn>] [--] <relPath>...
 *   bun scripts/publiser-felles-wiki.ts --status [--json] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot>
 *   bun scripts/publiser-felles-wiki.ts --synk [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot>
 *
 * `--fjern` sletter bare objektene som oppgis: datafilene en side viser, må
 * oppgis i tillegg til siden, ellers blir de liggende i bøtta.
 *
 * Bøtta er synklisten: hver side (.md .mdx .html) og `.wiki-reader.json` på
 * rotnivå som ligger i bøtta, følges. En side legges til ved å publisere den
 * én gang og tas ut med `--fjern`.
 *
 * `--status` endrer ingenting. Den lister bøtta med MD5, vurderer hver fulgte
 * side med samme sjekk som publiseringen (også datafilene siden viser, uten
 * `--tillat-ident` med NAVident-kolonnene fjernet fra CSV-kopien) og
 * sammenligner MD5 av byteene
 * som ville blitt lastet opp, med bøtta. Hver side får én tilstand:
 *   - `uendret`: siden og hver datafil den viser, er lik bøtta.
 *   - `endret`: siden eller en datafil den viser, er ulik bøtta eller ikke
 *     lastet opp ennå. Mangler bøtta MD5 (et sammensatt objekt), regnes filen
 *     som endret. En datafil siden viser som er slettet lokalt, men fortsatt
 *     ligger i bøtta, gjør også siden endret, med en advarsel: `--synk`
 *     sletter aldri, så bare `--fjern` rydder den.
 *   - `avvist`: sjekken avviser siden eller en datafil den viser nå, også mot
 *     navnene i bøtta. `--tillat-ident` virker som ved publisering.
 *   - `mangler-lokalt`: siden ligger i bøtta, men ikke under wiki-roten med
 *     nøyaktig samme navn (store og små bokstaver teller, også der filsystemet
 *     ikke skiller dem; navnene sammenlignes i NFC).
 * En datafil i bøtta er sikkert foreldreløs når ingen lest side viser den og
 * hver fulgt .md- og .mdx-side er `uendret`: da er sidens lokale referanser
 * nøyaktig de bøtteversjonen har. Er en slik side `endret`, `avvist` eller
 * `mangler-lokalt`, kan versjonen i bøtta vise en datafil den lokale ikke
 * viser. Da listes datafilene ingen lest side viser, som mulig foreldreløse,
 * med grunnen. En .md- eller .mdx-side som forblir avvist, holder dermed hver
 * foreldreløs datafil i `muligensForeldreløse`.
 * Skriptet skriver aldri en `--fjern`-kommando for en datafil: det vet ikke
 * hvilke datafiler bøtteversjonen av en side som ikke er uendret, viser, uten
 * å lese den. Foreldreløse og lokalt slettede datafiler listes med rådet om å
 * sjekke at ingen publisert side viser filen før den fjernes med `--fjern`.
 * Exit-kode 0 når statusen ble laget, uansett tilstander.
 *
 * `--status --json` skriver ett JSON-objekt på stdout og ingenting annet:
 *   { "bøtte": string,
 *     "sider": [{ "relPath": string,
 *                 "tilstand": "uendret" | "endret" | "avvist" | "mangler-lokalt",
 *                 "endredeFiler": string[],   // siden og/eller datafilene som er ulik bøtta
 *                 "avslag": string[],         // tom unntatt for avvist
 *                 "advarsler": string[] }],
 *     "foreldreløse": string[],          // sikre: ingen fulgt side kan vise dem
 *     "muligensForeldreløse": string[] }  // ingen lest side viser dem, men bøtteversjonen av en side som ikke er uendret, kan
 * `sider` er sortert på objektnavn. Hver sti med funn skrives maskert som
 * ellers (`[skjult sti: …]`), også i JSON. Ved feil (exit 2) er stdout tom og
 * feilen står på stderr.
 *
 * `--synk` lager statusen og publiserer så de endrede sidene på vanlig måte.
 * En endret side lastes opp når siden selv eller en datafil den viser, er ulik
 * bøtta; en datafil den viser, bare når MD5 er ulik bøtta eller filen mangler
 * der. En datafil lastes dermed aldri opp uten at en side som viser den, er
 * endret og lastes opp i samme kjøring. En side som er endret bare fordi en
 * datafil er slettet lokalt, lastes ikke opp: synk lister datafilen med rådet
 * om `--fjern` i stedet, og siden er `endret` til datafilen er fjernet fra
 * bøtta. Avviste sider og sider som mangler lokalt, rapporteres, men
 * publiseres ikke, og oppsummeringen teller dem. Med `--dry-run` lastes
 * ingenting opp, men bøtta listes for å lage statusen. Exit-kode: 2 når bøtta
 * ikke kan listes, gcloud mangler eller listen har uventet form (ingenting er
 * lastet opp); 3 når en opplasting feilet; ellers 1 når en side er avvist i
 * statusen eller publiseringen; ellers 0 (også når ingenting er endret).
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
 *     lastet opp i samme kjøring. Datafiler skannes som sider, med unntaket
 *     for CSV under «innhold». Med `--tillat-ident` er NAVident og e-post i en
 *     datafil advarsler, som i en side, og filen lastes opp byte for byte uten
 *     at noen kolonne fjernes. Uten flagget: er alle funnene i en CSV
 *     NAVident, fjernes hver kolonne med et funn fra kopien som lastes opp, og
 *     kopien skannes på nytt.
 *     Kildefilen endres ikke. Bare kommadelt, rektangulær CSV renses; filen
 *     avvises når et anførselstegn aldri lukkes eller følges av tekst før neste
 *     komma eller linjeskift, når en overskriftscelle uten anførselstegn har
 *     semikolon eller tabulator, når overskriften (første rad som ikke er en
 *     tom linje) har færre enn to kolonner, når en rad som ikke er tom har et
 *     annet antall kolonner enn overskriften, når det blir ingen kolonner igjen, og
 *     når kopien blir større enn 1 MB. Uten `--tillat-ident` avvises en NAVident
 *     i en .sql eller .yaml og en e-postadresse i alle datafiler. Et
 *     fødselsnummer, D-nummer eller H-nummer avvises i alle datafiler, før
 *     noen kolonne fjernes, også med flagget.
 *   - størrelse: over 2 MB for en side, 1 MB for en datafil, hopper speilet
 *     over objektet, så det avvises her.
 *   - koding: UTF-16 og UTF-32 (merke eller NUL-byte) avvises.
 *   - innhold og filnavn: fødselsnummer, D-nummer og H-nummer (kontrollsifre +
 *     dato; en dato med år 19xx–20xx, `23.10.2026`, blir ikke del av et slikt
 *     nummer, se DATO_FIRESIFRET_ÅR), e-postadresser og NAVident. Et
 *     organisasjonsnummer er offentlig (Enhetsregisteret) og skannes ikke.
 *     Teksten normaliseres først (NFKC, HTML-entiteter, usynlige tegn), så
 *     også sifre skilt av tabellceller eller formatering fanges. I en
 *     CSV-datafil slås sifre sammen på samme måte, også over komma og tomme
 *     celler, men ikke over en celle som ikke kan holde en del av et nummer:
 *     en celle i en post med minst to celler som (uten blanke rundt) er
 *       - et desimaltall med færre enn 11 sifre og en brøkdel som ikke bare
 *         er nuller (`1.2`, `-3.5`, `"1,2"` i anførselstegn), eller
 *       - en ISO-dato `YYYY-MM-DD` med gyldig måned og dag, eventuelt fulgt
 *         av `T` eller mellomrom og `HH:MM`, `:SS`, brøkdel av sekund og `Z`,
 *         `±HH` eller `±HH:MM`.
 *     Et tall med bare nuller i brøkdelen (`12345.0`, `345.00`) skannes som
 *     det er, nullene med. Alt annet skannes som
 *     i en side: tomme celler, `-`, tekst, celler i anførselstegn og over
 *     flere linjer, HTML i celler, linjenummer, og NAVident og e-post. En CSV
 *     der en celle uten anførselstegn, i hvilken som helst rad, har semikolon
 *     eller tabulator, en CSV som ikke kan leses, og .sql og .yaml skannes som
 *     en side. Bare e-post og NAVident kan slippes med
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
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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
export type FunnType = FnrType | "e-post" | "NAVident";

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

// ── Skanner ──────────────────────────────────────────────────────

/** Stor bokstav + 6 sifre. En git-SHA er små bokstaver og treffer ikke. */
const RE_NAVIDENT = /(?<![A-Za-z0-9])[A-Z]\d{6}(?![A-Za-z0-9])/g;
/** Tegn mellom sifergrupper som projeksjonen slår sammen over. */
const MAKS_MELLOMROM_PROJEKSJON = 5;
/** En rekke blanke, `|` og HTML-tagger. Hver rekke teller som ett skilletegn. */
const SKILLEREKKE = /(?:\s|\||<[^<>]{0,200}>)+/g;

/**
 * En dato med år 19xx eller 20xx (`23.10.2026`, `23/10/2026`, `23-10-2026`).
 * Et fødselsnummer har tosifret år, så en dato med behandlings-ID i neste
 * celle blir ikke et; et år utenfor 19xx–20xx (`15.03.8550 060`) kan være ÅÅ
 * og starten på personnummeret og skannes som før. Et fødselsnummer med ÅÅ 19
 * eller 20 skrevet `DD.MM.ÅÅNN NNN` fanges ikke.
 */
const DATO_FIRESIFRET_ÅR = /(?<!\d)(?:0?[1-9]|[12]\d|3[01])([./-])(?:0?[1-9]|1[0-2])\1(?:19|20)\d\d(?!\d)/g;

/**
 * 11-sifrede kandidater fra linjens sifre alene. Hver rekke av blanke, `|` og
 * HTML-tagger telles først som ett tegn, og en dato med firesifret år skiller
 * som en bokstav. Sifergrupper skilt av høyst
 * MAKS_MELLOMROM_PROJEKSJON tegn uten bokstaver slås så sammen, og hver
 * sammenhengende rekke grupper som til sammen har nøyaktig 11 sifre, blir en
 * kandidat. Det dekker `15038512345`, `150385 12345`, `150385.12345`,
 * `15.03.85 12345`, `| 150385     | 12345 |` (prettier-justert),
 * `**150385**12345` og `<td>…</td><td>…</td>`, men ikke `150385 og 12345`.
 */
export function sifferkandidater(linje: string): string[] {
  const uten = linje.replace(SKILLEREKKE, " ").replace(DATO_FIRESIFRET_ÅR, "x");
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

/**
 * Skanner tekst linje for linje. Samme type + verdi rapporteres én gang, med antall.
 * `sifferTekst` (fra `csvSifferTekst`): samme tekst med cellene som ikke kan
 * holde en del av et nummer, byttet ut. Kandidatene til fødselsnummer leses
 * fra den; de andre funnene leses fra `tekst`. Har den et annet antall linjer,
 * brukes `tekst`.
 */
export function skannTekst(tekst: string, sifferTekst?: string): Funn[] {
  const funn = new Map<string, Funn>();
  const legg = (linje: number, type: FunnType, verdi: string, ident: boolean) => {
    const nøkkel = `${type}\u0000${verdi}`;
    const f = funn.get(nøkkel);
    if (f) f.antall++;
    else funn.set(nøkkel, { linje, type, maskert: masker(verdi), ident, antall: 1 });
  };
  const linjer = tekst.split(/\r?\n/);
  const sifferLinjer = sifferTekst?.split(/\r?\n/);
  const sifre = sifferLinjer?.length === linjer.length ? sifferLinjer : linjer;
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
    const nr = i + 1;
    const linje = normaliserLinje(linjer[i]!);
    const sifferlinje = sifre === linjer ? linje : normaliserLinje(sifre[i]!);
    const enkelt = new Set(sifferkandidater(sifferlinje));
    for (const tall of enkelt) {
      const type = klassifiser11(tall);
      if (type) legg(nr, type, tall, false);
    }
    if (erCellelinje(sifferlinje)) {
      celler ??= { start: nr, tekst: [], enkelt: new Set() };
      celler.tekst.push(sifferlinje);
      for (const t of enkelt) celler.enkelt.add(t);
    } else tømCeller();
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
  /** Cellens plass i kildeteksten, anførselstegn med og skilletegnet etter uten: `[fra, til)`. */
  fra: number;
  til: number;
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
  let fra = 0;
  const nyCelle = () => {
    post.push({ tekst: felt, sitert, fra, til: i });
    felt = "";
    sitert = false;
    fra = i + 1;
  };
  const nyPost = (slutt: string) => {
    nyCelle();
    poster.push({ celler: post, slutt });
    post = [];
    fra = i + slutt.length;
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

/** `YYYY-MM-DD`, eventuelt med klokkeslett, brøkdel av sekund og tidssone. */
const ISO_DATO = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::\d{2})?)?)?$/;
/**
 * Et desimaltall. Et ASCII-komma står bare i en celle i anførselstegn; et
 * komma i full bredde eller lite komma (U+FF0C, U+FE50) blir et komma etter
 * NFKC og kan stå i en celle uten.
 */
const DESIMALTALL = /^([+-]?\d+)[.,](\d+)$/;

/**
 * Det cellen byttes ut med i `csvSifferTekst`, eller null når den skannes som
 * den er: `x` for en ISO-dato og for et desimaltall med færre enn 11 sifre og
 * en brøkdel som ikke bare er nuller. Et tall med bare nuller i brøkdelen
 * (`12345.0`) skannes som det er, nullene med, som på main.
 */
function sifferCelle(c: Celle): string | null {
  if (/[\r\n]/.test(c.tekst)) return null;
  const t = normaliserLinje(c.tekst).trim();
  if (ISO_DATO.test(t)) return "x";
  const d = DESIMALTALL.exec(t);
  if (!d) return null;
  if (/^0+$/.test(d[2]!)) return null;
  return t.replace(/\D/g, "").length < 11 ? "x" : null;
}

/**
 * Teksten skanneren leser kandidater til fødselsnummer fra i en CSV-datafil:
 * i hver post med minst to celler byttes en celle som ikke kan holde en del
 * av et nummer, ut etter `sifferCelle`. Har en celle uten anførselstegn et
 * semikolon eller en tabulator, i hvilken som helst post, kan filen være
 * delt med det tegnet, et komma er da ikke sikkert et skilletegn, og teksten
 * er uendret. Bokstaven `x` stopper sammenslåingen over cellen, slik en
 * bokstav gjør i en side. Linjene er de samme som i kildeteksten. Null når
 * filen ikke kan leses som CSV.
 */
export function csvSifferTekst(tekst: string): string | null {
  const lest = lesCsv(tekst);
  if ("feil" in lest) return null;
  // Hele filen, ikke bare overskriften: en tittellinje, en overskrift med én kolonne eller i anførselstegn skjuler skilletegnet.
  if (lest.poster.some((p) => p.celler.some((c) => !c.sitert && /[;\t]/.test(c.tekst)))) return tekst;
  const biter: string[] = [];
  let pos = 0;
  for (const post of lest.poster) {
    if (post.celler.length < 2) continue;
    for (const c of post.celler) {
      const ny = sifferCelle(c);
      if (ny === null) continue;
      biter.push(tekst.slice(pos, c.fra), ny);
      pos = c.til;
    }
  }
  biter.push(tekst.slice(pos));
  return biter.join("");
}

/** Skanner en CSV-datafil: som en side, men kandidatene til fødselsnummer leses fra `csvSifferTekst`. */
export function skannCsv(tekst: string): Funn[] {
  return skannTekst(tekst, csvSifferTekst(tekst) ?? undefined);
}

/** En tom linje: én tom celle uten anførselstegn. Muninns leser hopper over den. */
function erTom(p: Post): boolean {
  return p.celler.length === 1 && p.celler[0]!.tekst === "" && !p.celler[0]!.sitert;
}

/**
 * `semikolon` eller `tabulator` når en celle uten anførselstegn i overskriften
 * (første post som ikke er en tom linje) har det tegnet, ellers null.
 */
function overskriftSkilletegn(poster: Post[]): "semikolon" | "tabulator" | null {
  const overskrift = poster.find((p) => !erTom(p))?.celler ?? [];
  // Et komma i et felt (desimalkomma) gir en semikolondelt fil flere kolonner, så bredden alene avslører den ikke.
  const usitert = overskrift.filter((c) => !c.sitert).map((c) => c.tekst).join("");
  return usitert.includes(";") ? "semikolon" : usitert.includes("\t") ? "tabulator" : null;
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
  const skilletegn = overskriftSkilletegn(poster);
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
 * verken e-post eller NAVident.
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
 * datagrensen, en CSV skannes med `skannCsv`, og uten `--tillat-ident` får en
 * CSV kolonnene med NAVident fjernet fra kopien, som så skannes på nytt.
 */
export function vurderFil(abs: string, rel: string, tillatIdent: boolean, nr?: number, datafil = false): Vurdering {
  const visning = visningsnavn(rel, nr);
  const v: Vurdering = { rel, objekt: rel.normalize("NFC"), visning, avslag: [], advarsler: [], fjernet: [] };
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
  const skann = datafil && datatype(rel) === "csv" ? skannCsv : skannTekst;
  // Uten --tillat-ident fjernes kolonner bare når alle funnene i kildefilen er
  // NAVident. Ellers avvises filen på funnene i kildefilen, så et
  // fødselsnummer i en kolonne som også har en NAVident, ikke forsvinner med
  // kolonnen. Med --tillat-ident lastes kildefilen opp som den er.
  const kildefunn = skann === skannCsv && !tillatIdent ? skann(tekst) : [];
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
  for (const f of skann(tekst)) {
    const antall = f.antall > 1 ? ` (${f.antall} forekomster)` : "";
    const linje = `${visning}:${f.linje}: ${f.type} ${f.maskert}${antall}`;
    if (f.ident && tillatIdent) v.advarsler.push(`${linje} (tillatt med --tillat-ident)`);
    else if (v.fjernet.length > 0) v.avslag.push(`${linje} (i kopien etter at kolonnene er fjernet)`);
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
  status: boolean;
  synk: boolean;
  json: boolean;
  bucket?: string;
  posisjonelle: string[];
}

function lesArgs(argv: string[]): Valg | string {
  const v: Valg = { dryRun: false, tillatIdent: false, fjern: false, ja: false, status: false, synk: false, json: false, posisjonelle: [] };
  let bareStier = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (bareStier) v.posisjonelle.push(a);
    else if (a === "--") bareStier = true;
    else if (a === "--dry-run") v.dryRun = true;
    else if (a === "--tillat-ident") v.tillatIdent = true;
    else if (a === "--fjern") v.fjern = true;
    else if (a === "--ja") v.ja = true;
    else if (a === "--status") v.status = true;
    else if (a === "--synk") v.synk = true;
    else if (a === "--json") v.json = true;
    else if (a === "--bucket") {
      const b = argv[++i];
      if (!b) return "--bucket mangler verdi";
      v.bucket = b;
    } else if (a.startsWith("--bucket=")) v.bucket = a.slice("--bucket=".length);
    else if (a === "-h" || a === "--help") return "";
    else if (a.startsWith("-")) return `ukjent flagg: ${a}`;
    else v.posisjonelle.push(a);
  }
  if ([v.fjern, v.status, v.synk].filter(Boolean).length > 1) return "--fjern, --status og --synk kan ikke kombineres";
  if (v.json && !v.status) return "--json gjelder bare --status";
  if (v.fjern) {
    if (v.posisjonelle.length === 0) return "--fjern mangler relPath";
    if (v.tillatIdent) return "--tillat-ident gjelder ikke --fjern";
  } else {
    if (v.ja) return "--ja gjelder bare --fjern";
    if (v.status || v.synk) {
      const flagg = v.status ? "--status" : "--synk";
      if (v.posisjonelle.length !== 1) return `${flagg} tar nøyaktig én sti: wiki-roten`;
      if (v.status && v.dryRun) return "--dry-run gjelder ikke --status, som ikke endrer noe";
    } else if (v.posisjonelle.length < 2) return "mangler wiki-rot eller relPath";
  }
  return v;
}

const BRUK = [
  "Bruk: bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot> <relPath>...",
  "      bun scripts/publiser-felles-wiki.ts --fjern [--ja] [--dry-run] [--bucket <navn>] [--] <relPath>...",
  "      bun scripts/publiser-felles-wiki.ts --status [--json] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot>",
  "      bun scripts/publiser-felles-wiki.ts --synk [--dry-run] [--tillat-ident] [--bucket <navn>] [--] <wiki-rot>",
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

export interface Objekt {
  navn: string;
  /** `md5_hash` fra gcloud (base64), eller null når bøtta ikke har en (sammensatt objekt). */
  md5: string | null;
}

/**
 * De levende objektene i bøtta med MD5, eller en feilmelding.
 *
 * `gs://<bøtte>/**`, ikke `gs://<bøtte>`: gcloud gjør en bar bøtte om til
 * `gs://<bøtte>/*`, som bare lister toppnivået, og nesten alle sider ligger i
 * en mappe. `objects list` tar med ikke-gjeldende versjoner som standard og
 * har ikke noe flagg som bare gir de levende (`--stat` endrer utdataformatet),
 * så en versjon med `noncurrent_time` hoppes over her — speilet ser den ikke.
 * En liste med en annen form enn ventet avviser hele kjøringen, i stedet for
 * å sjekke mot en liste som kanskje mangler navn. `md5_hash` hentes bare for
 * statusen (`medMd5`), og en verdi som ikke er en streng, regnes som manglende
 * MD5 — publiseringen lister bøtta som før.
 */
function listObjekter(bucket: string, o: Omgivelser, medMd5 = false): Objekt[] | string {
  const format = medMd5 ? "--format=json(name,md5_hash,noncurrent_time)" : "--format=json(name,noncurrent_time)";
  const r = o.gcloud!(["storage", "objects", "list", `gs://${bucket}/**`, format]);
  if (r.exitCode !== 0) return `gcloud storage objects list feilet (exit ${r.exitCode}): ${maskerGcloud(r.stderr, [])}`;
  let data: unknown;
  try {
    data = JSON.parse(r.stdout.trim() || "[]");
  } catch {
    return "kunne ikke lese objektlisten fra gcloud";
  }
  if (!Array.isArray(data)) return "objektlisten fra gcloud er ikke en liste";
  const ut: Objekt[] = [];
  for (const x of data) {
    if (typeof x !== "object" || x === null || typeof (x as { name?: unknown }).name !== "string") {
      return "objektlisten fra gcloud har en oppføring uten navn";
    }
    if ((x as { noncurrent_time?: unknown }).noncurrent_time != null) continue;
    const md5 = (x as { md5_hash?: unknown }).md5_hash;
    ut.push({ navn: (x as { name: string }).name, md5: typeof md5 === "string" && md5 !== "" ? md5 : null });
  }
  return ut;
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

// ── Vurdering av en kjøring ──────────────────────────────────────

interface Kjøring {
  /** Sidene først, i oppgitt rekkefølge, så datafilene de viser. */
  vurderinger: Vurdering[];
  /** Hver datafil som vurderes, med sidene som viser den. */
  sideneTil: Map<Vurdering, Vurdering[]>;
  /** Hver side med datafilene den viser som vurderes, også de som avvises på stien. */
  datafilerTil: Map<Vurdering, Vurdering[]>;
  /** Stiene (under roten) til hver datafil sidene viser, også de som ikke finnes. */
  navngitt: Set<string>;
  /** Hver side med stiene til datafilene den viser som ikke finnes lokalt. */
  manglerTil: Map<Vurdering, string[]>;
  /** Avviser en datafil når alle sidene som viser den, er avvist. Kjøres etter hver sjekk som kan avvise en side. */
  avvisDatafilerUtenSide: () => void;
}

const SIDE_AVVIST = "siden som viser filen, er avvist";

/**
 * Vurderer stiene og datafilene sidene viser, slik publiseringen gjør det før
 * bøtta kontaktes: sti, skanning, CSV-rensing og kollisjoner innad i kjøringen.
 * `nummerer`: en maskert sti får løpenummeret fra kommandolinjen (statusen har ingen).
 */
function vurderKjøring(rot: string, oppgitt: string, stier: string[], tillatIdent: boolean, nummerer = true): Kjøring {
  const vurderinger: Vurdering[] = [];
  const sett = new Set<string>();
  // En datafil oppgitt alene vurderes etter sidene: den slipper bare gjennom
  // når en side i samme kjøring viser den.
  const oppgittData: { rel: string; nr: number | undefined }[] = [];
  stier.forEach((s, indeks) => {
    const i = nummerer ? indeks : undefined;
    const nr = i === undefined ? undefined : i + 1;
    const r = relUnder(rot, oppgitt, s);
    if (typeof r === "string") {
      vurderinger.push({ rel: s, objekt: s, visning: visningsnavn(s, nr), avslag: [r], advarsler: [], fjernet: [] });
      return;
    }
    if (sett.has(r.rel)) return;
    sett.add(r.rel);
    if (datatype(r.rel) !== null) oppgittData.push({ rel: r.rel, nr });
    else vurderinger.push(vurderFil(r.abs, r.rel, tillatIdent, nr));
  });

  // Datafilene sidene viser, i kilderekkefølge, med sidene som viser dem.
  // Sidene står før datafilene i `vurderinger`, så de lastes opp først.
  const sideneTil = new Map<Vurdering, Vurdering[]>();
  const visesAv = new Map<string, Vurdering[]>();
  const datafilerTil = new Map<Vurdering, Vurdering[]>();
  const manglerTil = new Map<Vurdering, string[]>();
  const knytt = (v: Vurdering, sider: Vurdering[]) => {
    for (const side of sider) datafilerTil.set(side, [...(datafilerTil.get(side) ?? []), v]);
  };
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
      const v: Vurdering = { rel, objekt: rel.normalize("NFC"), visning: visningsnavn(rel), avslag: [r], advarsler: [], fjernet: [] };
      knytt(v, sider);
      vurderinger.push(v);
      continue;
    }
    let finnes = true;
    try {
      lstatSync(r.abs);
    } catch {
      finnes = false;
    }
    if (!finnes) {
      for (const side of sider) {
        side.advarsler.push(`${visningsnavn(rel)}: filen finnes ikke — kortet viser «File not available»`);
        manglerTil.set(side, [...(manglerTil.get(side) ?? []), rel]);
      }
      continue;
    }
    sett.add(rel);
    const v = vurderFil(r.abs, rel, tillatIdent, undefined, true);
    sideneTil.set(v, sider);
    knytt(v, sider);
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

  const avvisDatafilerUtenSide = () => {
    for (const [v, sider] of sideneTil) {
      if (sider.every((side) => side.avslag.length > 0) && !v.avslag.includes(SIDE_AVVIST)) v.avslag.push(SIDE_AVVIST);
    }
  };
  avvisDatafilerUtenSide();
  return { vurderinger, sideneTil, datafilerTil, navngitt: new Set([...visesAv.keys()].map((r) => r.normalize("NFC"))), manglerTil, avvisDatafilerUtenSide };
}

/** Avviser hver godkjent fil som kolliderer med et annet levende objekt i bøtta under små bokstaver + NFC. */
function avvisKollisjonerMotBøtta(godkjent: Vurdering[], eksisterende: string[]): void {
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
}

/** `advarsler` uten «filen finnes ikke»-advarselen for datafilene i `iBøtta` (slettet lokalt, men i bøtta). */
function utenFalskManglerAdvarsel(advarsler: string[], iBøtta: string[]): string[] {
  const falske = new Set(iBøtta.map((rel) => `${visningsnavn(rel)}: filen finnes ikke — kortet viser «File not available»`));
  return advarsler.filter((a) => !falske.has(a));
}

// ── Publisering ──────────────────────────────────────────────────

/** Det `--synk` gir publiseringen fra statusen. */
interface SynkInfo {
  /** MD5 per objekt i bøtta (null: bøtta oppgir ingen). En datafil med samme MD5 lastes ikke opp. */
  md5: Map<string, string | null>;
  /** Sider avvist i statusen; de telles som avvist i oppsummeringen. */
  avvistIStatus: number;
  manglerLokalt: number;
}

function publiser(valg: Valg, bucket: string, rot: string, oppgitt: string, stier: string[], o: Omgivelser, synk?: SynkInfo): number {
  const ingress = typeof o.vars.ingress === "string" ? o.vars.ingress : "https://melosys-muninn.ansatt.nav.no";
  // Synk sender stiene fra statusen, ikke fra kommandolinjen, så de får ikke løpenummer.
  const { vurderinger, sideneTil, manglerTil, avvisDatafilerUtenSide } = vurderKjøring(rot, oppgitt, stier, valg.tillatIdent, synk === undefined);
  // Under synk: en datafil slettet lokalt, men fortsatt i bøtta, viser den gamle filen, ikke «File not available».
  const advarsler = (v: Vurdering) =>
    synk === undefined ? v.advarsler : utenFalskManglerAdvarsel(v.advarsler, (manglerTil.get(v) ?? []).filter((rel) => synk.md5.has(rel.normalize("NFC"))));

  const utskriv = (v: Vurdering) => {
    o.ut(`${v.avslag.length ? "AVVIST " : "OK     "} ${v.visning}`);
    for (const a of v.avslag) o.ut(`    avslag: ${a}`);
    for (const k of v.fjernet) o.ut(`    fjernet kolonne: ${k.navn} (NAVident i ${k.rader} rad(er)) — bare fra kopien, kildefilen er uendret`);
    for (const a of advarsler(v)) o.ut(`    advarsel: ${a}`);
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
    avvisKollisjonerMotBøtta(godkjent, eksisterende.map((e) => e.navn));
    avvisDatafilerUtenSide();
    godkjent = godkjent.filter((v) => v.avslag.length === 0);
  }

  vurderinger.forEach(utskriv);

  // Synk: en datafil som er lik bøtta, lastes ikke opp på nytt.
  const likBøtta = (v: Vurdering) => synk !== undefined && sideneTil.has(v) && v.bytes !== undefined && synk.md5.get(v.objekt) === md5Base64(v.bytes);
  for (const v of godkjent) if (likBøtta(v)) o.ut(`uendret i bøtta, lastes ikke opp: ${v.visning}`);
  const tilOpplasting = godkjent.filter((v) => !likBøtta(v));

  if (valg.dryRun) {
    for (const v of tilOpplasting) o.ut(`vil laste opp gs://${bucket}/${v.visning}`);
    if (tilOpplasting.length > 0) {
      o.ut(
        synk
          ? "(tørrkjøring: ingenting er lastet opp; bøtta er listet, og kollisjoner med eksisterende objekter er sjekket i statusen over)"
          : "(tørrkjøring: bøtta er ikke kontaktet, så kollisjoner med eksisterende objekter er ikke sjekket)",
      );
    }
  } else {
    // En datafil lastes bare opp når minst én side som viser den, ble lastet opp i denne kjøringen.
    const opplastet = new Set<Vurdering>();
    for (const v of tilOpplasting) {
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

  const sider = (valg.dryRun ? tilOpplasting : lastetOpp).filter((v) => SIDE_ENDELSER.has(path.posix.extname(v.objekt).toLowerCase()));
  if (sider.length > 0) {
    o.ut(valg.dryRun ? "\nTørrkjøring — ingenting er lastet opp. Adresser etter publisering:" : "\nPublisert. Speilet i poden henter endringer omtrent hvert 2. minutt:");
    // En sti med funn, også en som --tillat-ident slapp gjennom, vises maskert her som overalt ellers.
    for (const v of sider) o.ut(`  ${ingress}/wiki?wiki=melosys-felles&relPath=${v.visning === v.rel ? encodeURIComponent(v.objekt) : v.visning}`);
  }
  const avvist = vurderinger.filter((v) => v.avslag.length > 0).length + (synk?.avvistIStatus ?? 0);
  const mangler = synk ? `, ${synk.manglerLokalt} mangler lokalt` : "";
  o.ut(
    valg.dryRun
      ? `\nOppsummering: ${tilOpplasting.length} klar(e), ${avvist} avvist${mangler}.`
      : `\nOppsummering: ${lastetOpp.length} lastet opp, ${avvist} avvist, ${feilet.length} feilet${mangler}.`,
  );
  if (feilet.length > 0) return EXIT_FEILET;
  if (avvist > 0) return EXIT_AVVIST;
  return EXIT_OK;
}

// ── Status og synk ───────────────────────────────────────────────

export type Tilstand = "uendret" | "endret" | "avvist" | "mangler-lokalt";

export interface SideStatus {
  /** Objektnavnet, maskert når det har et funn. */
  relPath: string;
  tilstand: Tilstand;
  /** Siden og/eller datafilene den viser som er ulik bøtta, maskert som `relPath`. */
  endredeFiler: string[];
  avslag: string[];
  advarsler: string[];
}

export interface Status {
  bøtte: string;
  sider: SideStatus[];
  /** Datafiler i bøtta som ingen fulgt side viser, maskert. Tom når en fulgt .md- eller .mdx-side ikke er `uendret`. */
  foreldreløse: string[];
  /** Datafiler i bøtta som ingen lest side viser, når en fulgt .md- eller .mdx-side ikke er `uendret`, maskert. */
  muligensForeldreløse: string[];
}

interface StatusResultat {
  status: Status;
  /** De lokale stiene (umaskert) til sidene som er endret og har noe å laste opp, til `--synk`. */
  endredeObjekter: string[];
  /**
   * Sidene som er endret bare fordi datafiler de viser, er slettet lokalt, men ligger i bøtta:
   * siden og de andre datafilene er lik bøtta, så `--synk` har ingenting å laste opp.
   * `slettet` er de slettede datafilene, maskert.
   */
  bareSlettet: { visning: string; slettet: string[] }[];
  /** MD5 per objekt i bøtta, til `--synk`. */
  md5: Map<string, string | null>;
  /** Hvor mange fulgte .md- og .mdx-sider som ikke er `uendret`, og derfor kan vise datafiler i bøtteversjonen sin. */
  ikkeUendret: number;
}

function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

/** Ett argument for sh, bash og zsh: uendret med bare trygge tegn, ellers i enkle anførselstegn. */
export function skallsitat(s: string): string {
  return /^[A-Za-z0-9_/.,:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Kommandolinjen for skriptet med argumentene sitert. */
function kommando(args: string[]): string {
  return `bun scripts/publiser-felles-wiki.ts ${args.map(skallsitat).join(" ")}`;
}

/**
 * Rådet der skriptet ellers kunne foreslått `--fjern` for en datafil. Det foreslår aldri
 * kommandoen: en side som ikke er uendret, kan vise filen i bøtteversjonen sin.
 */
const FJERN_RÅD = "sjekk at ingen publisert side viser filen før du fjerner den med --fjern";
const stor = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Følges: en side (.md .mdx .html) hvor som helst, eller leserkonfigen på rotnivå. */
function erFulgt(navn: string): boolean {
  return navn === LESER_KONFIG || SIDE_ENDELSER.has(endelse(navn));
}

/**
 * Den lokale stien som har nøyaktig objektnavnet i hvert ledd (NFC-sammenlignet),
 * eller null. `lstat` er ikke nok: på et filsystem som ikke skiller store og små
 * bokstaver, finner den `Plan.md` for objektet `plan.md`.
 */
function lokalSti(rot: string, navn: string, mapper: Map<string, string[] | null>): string | null {
  let cur = rot;
  const deler: string[] = [];
  for (const ledd of navn.split("/")) {
    let oppføringer = mapper.get(cur);
    if (oppføringer === undefined) {
      try {
        oppføringer = readdirSync(cur);
      } catch {
        oppføringer = null;
      }
      mapper.set(cur, oppføringer);
    }
    const nfc = ledd.normalize("NFC");
    const treff = oppføringer?.includes(ledd) ? ledd : oppføringer?.find((e) => e.normalize("NFC") === nfc);
    if (treff === undefined) return null;
    deler.push(treff);
    cur = path.join(cur, treff);
  }
  return deler.join("/");
}

/** Statusen for hver fulgte side i bøtta, eller en feilmelding (bøtta kunne ikke listes). */
function lagStatus(bucket: string, rot: string, tillatIdent: boolean, o: Omgivelser): StatusResultat | string {
  if (!o.gcloud) return "finner ikke gcloud på PATH";
  const objekter = listObjekter(bucket, o, true);
  if (typeof objekter === "string") return objekter;
  const md5 = new Map(objekter.map((x) => [x.navn, x.md5]));

  const fulgte = objekter.map((x) => x.navn).filter(erFulgt).sort();
  const lokale: { objekt: string; lokal: string }[] = [];
  const sider: (SideStatus & { objekt: string })[] = [];
  const kanViseData = (navn: string) => [".md", ".mdx"].includes(endelse(navn));
  const mapper = new Map<string, string[] | null>();
  for (const navn of fulgte) {
    const form = sjekkStiform(navn);
    const lokal = form ? null : lokalSti(rot, navn, mapper);
    if (form) sider.push({ objekt: navn, relPath: visningsnavn(navn), tilstand: "avvist", endredeFiler: [], avslag: [form], advarsler: [] });
    else if (lokal !== null) lokale.push({ objekt: navn, lokal });
    else sider.push({ objekt: navn, relPath: visningsnavn(navn), tilstand: "mangler-lokalt", endredeFiler: [], avslag: [], advarsler: [] });
  }

  const k = vurderKjøring(rot, rot, lokale.map((l) => l.lokal), tillatIdent, false);
  avvisKollisjonerMotBøtta(
    k.vurderinger.filter((v) => v.avslag.length === 0),
    objekter.map((x) => x.navn),
  );
  k.avvisDatafilerUtenSide();

  /** Legger filen til `endredeFiler` når byteene publiseringen ville lastet opp, er ulik bøtta. Gir true da. */
  const sammenlign = (v: Vurdering, s: SideStatus): boolean => {
    const fasit = md5.get(v.objekt);
    if (fasit === undefined) s.advarsler.push(`${v.visning}: ikke lastet opp ennå`);
    else if (fasit === null) s.advarsler.push(`${v.visning}: bøtta oppgir ingen MD5 (sammensatt objekt), så filen regnes som endret`);
    else if (md5Base64(v.bytes!) === fasit) return false;
    s.endredeFiler.push(v.visning);
    return true;
  };

  const endredeObjekter: string[] = [];
  const bareSlettet: StatusResultat["bareSlettet"] = [];
  for (const { objekt, lokal } of lokale) {
    const side = k.vurderinger.find((v) => v.rel === lokal);
    const s: SideStatus & { objekt: string } = { objekt, relPath: visningsnavn(objekt), tilstand: "uendret", endredeFiler: [], avslag: [], advarsler: [] };
    sider.push(s);
    if (!side) {
      // Skal ikke skje: hvert navn i bøtta er unikt, og vurderKjøring gir en vurdering per sti.
      s.tilstand = "avvist";
      s.avslag.push("siden ble ikke vurdert");
      continue;
    }
    // `d.csv` og `./d.csv` er samme fil: hver fil står én gang.
    const datafiler = [...new Set(k.datafilerTil.get(side) ?? [])];
    // Slettet lokalt, men fortsatt i bøtta: poden viser den gamle filen, ikke «File not available».
    const iBøtta = [...new Set(k.manglerTil.get(side) ?? [])].filter((rel) => md5.has(rel.normalize("NFC")));
    s.advarsler.push(...new Set(utenFalskManglerAdvarsel(side.advarsler, iBøtta)));
    s.avslag.push(...side.avslag);
    for (const d of datafiler) for (const a of d.advarsler) s.advarsler.push(a.startsWith(`${d.visning}:`) ? a : `${d.visning}: ${a}`);
    // Et skannerfunn starter allerede med filens visning (`sti:linje: …`); andre avslag får den foran.
    for (const d of datafiler) for (const a of d.avslag) if (a !== SIDE_AVVIST) s.avslag.push(a.startsWith(`${d.visning}:`) ? a : `${d.visning}: ${a}`);
    if (s.avslag.length > 0) {
      s.tilstand = "avvist";
      continue;
    }
    // Hver fil sammenlignes, så hver ulik fil står i `endredeFiler`.
    const ulik = [side, ...datafiler].map((v) => sammenlign(v, s)).includes(true);
    const slettet = [...new Set(iBøtta.map((rel) => rel.normalize("NFC")))].map((n) => visningsnavn(n));
    for (const visning of slettet) {
      s.endredeFiler.push(visning);
      s.advarsler.push(`${visning}: finnes ikke lokalt, men ligger fortsatt i bøtta, og kortet viser den gamle filen. --synk sletter aldri; ${FJERN_RÅD}.`);
    }
    if (s.endredeFiler.length > 0) s.tilstand = "endret";
    if (ulik) endredeObjekter.push(lokal);
    else if (slettet.length > 0) bareSlettet.push({ visning: s.relPath, slettet });
  }
  // Bare en `uendret` side har lokale referanser som er nøyaktig bøtteversjonens.
  const ikkeUendret = sider.filter((s) => s.tilstand !== "uendret" && kanViseData(s.objekt)).length;
  sider.sort((a, b) => (a.objekt < b.objekt ? -1 : a.objekt > b.objekt ? 1 : 0));

  const uten = objekter
    .map((x) => x.navn)
    .filter((n) => datatype(n) !== null && !k.navngitt.has(n.normalize("NFC")))
    .sort();
  const maskert = uten.map((n) => visningsnavn(n));
  return {
    status: {
      bøtte: bucket,
      sider: sider.map(({ objekt: _, ...s }) => s),
      foreldreløse: ikkeUendret > 0 ? [] : maskert,
      muligensForeldreløse: ikkeUendret > 0 ? maskert : [],
    },
    endredeObjekter,
    bareSlettet,
    md5,
    ikkeUendret,
  };
}

const TILSTAND_ETIKETT: Record<Tilstand, string> = {
  uendret: "UENDRET       ",
  endret: "ENDRET        ",
  avvist: "AVVIST        ",
  "mangler-lokalt": "MANGLER LOKALT",
};

/** `hint`: valgene `--status` ble kjørt med, så synk-forslaget får de samme; null under `--synk`. */
function skrivStatus(r: StatusResultat, rotArg: string, hint: Valg | null, o: Omgivelser): void {
  const { status } = r;
  o.ut(`Status for gs://${status.bøtte}: ${status.sider.length} fulgt(e) side(r)`);
  for (const s of status.sider) {
    o.ut(`${TILSTAND_ETIKETT[s.tilstand]} ${s.relPath}`);
    for (const f of s.endredeFiler) o.ut(`    endret: ${f}`);
    for (const a of s.avslag) o.ut(`    avslag: ${a}`);
    for (const a of s.advarsler) o.ut(`    advarsel: ${a}`);
  }
  if (status.foreldreløse.length > 0) {
    o.ut("\nDatafiler i bøtta som ingen fulgt side viser lenger (bare til info):");
    for (const f of status.foreldreløse) o.ut(`FORELDRELØS     ${f}`);
    o.ut(`  ${stor(FJERN_RÅD)}.`);
  }
  if (status.muligensForeldreløse.length > 0) {
    o.ut(
      `\nDatafiler i bøtta som ingen lest side viser. ${r.ikkeUendret} fulgt(e) .md- eller .mdx-side(r) er ikke uendret ` +
        "(endret, avvist eller mangler lokalt), og versjonen i bøtta kan vise dem, så de kan være i bruk:",
    );
    for (const f of status.muligensForeldreløse) o.ut(`MULIG FORELDRELØS ${f}`);
    o.ut(`  ${stor(FJERN_RÅD)}.`);
  }
  const antall = (t: Tilstand) => status.sider.filter((s) => s.tilstand === t).length;
  const mulige = status.muligensForeldreløse.length > 0 ? `, ${status.muligensForeldreløse.length} mulig foreldreløs(e)` : "";
  o.ut(
    `\nOppsummering: ${antall("uendret")} uendret, ${antall("endret")} endret, ${antall("avvist")} avvist, ` +
      `${antall("mangler-lokalt")} mangler lokalt, ${status.foreldreløse.length} foreldreløs(e) datafil(er)${mulige}.`,
  );
  if (hint && r.endredeObjekter.length > 0) {
    const flagg = [...(hint.tillatIdent ? ["--tillat-ident"] : []), ...(hint.bucket !== undefined ? ["--bucket", hint.bucket] : [])];
    o.ut(`Synk de endrede med: ${kommando(["--synk", ...flagg, "--", rotArg])}`);
  }
}

function synk(valg: Valg, bucket: string, rot: string, rotArg: string, o: Omgivelser): number {
  const r = lagStatus(bucket, rot, valg.tillatIdent, o);
  if (typeof r === "string") {
    o.feil(`Feil: ${r} — ingenting er lastet opp`);
    return EXIT_BRUK;
  }
  skrivStatus(r, rotArg, null, o);
  const antall = (t: Tilstand) => r.status.sider.filter((s) => s.tilstand === t).length;
  const info: SynkInfo = { md5: r.md5, avvistIStatus: antall("avvist"), manglerLokalt: antall("mangler-lokalt") };
  for (const b of r.bareSlettet) {
    o.ut(`\nIngenting å laste opp for ${b.visning}: bare datafiler slettet lokalt er ulik bøtta.`);
    for (const f of b.slettet) o.ut(`    slettet lokalt: ${f}`);
    o.ut(`  ${stor(FJERN_RÅD)}.`);
  }
  if (r.endredeObjekter.length === 0) {
    o.ut(r.bareSlettet.length > 0 ? "\nIngenting å synke: ingen endret side har noe å laste opp." : "\nIngenting å synke: ingen fulgt side er endret.");
    o.ut(
      valg.dryRun
        ? `\nOppsummering: 0 klar(e), ${info.avvistIStatus} avvist, ${info.manglerLokalt} mangler lokalt.`
        : `\nOppsummering: 0 lastet opp, ${info.avvistIStatus} avvist, 0 feilet, ${info.manglerLokalt} mangler lokalt.`,
    );
    return info.avvistIStatus > 0 ? EXIT_AVVIST : EXIT_OK;
  }
  o.ut(`\nSynker ${r.endredeObjekter.length} endret(e) side(r):\n`);
  return publiser(valg, bucket, rot, rot, r.endredeObjekter, o, info);
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
  const oppgitt = path.resolve(rotArg!);
  if (!existsSync(oppgitt) || !statSync(oppgitt).isDirectory()) {
    o.feil("Feil: wiki-roten finnes ikke eller er ikke en mappe");
    return EXIT_BRUK;
  }
  const rot = realpathSync(oppgitt);

  if (valg.status) {
    const r = lagStatus(bucket, rot, valg.tillatIdent, o);
    if (typeof r === "string") {
      o.feil(`Feil: ${r}`);
      return EXIT_BRUK;
    }
    if (valg.json) o.ut(JSON.stringify(r.status, null, 2));
    else skrivStatus(r, rotArg!, valg, o);
    return EXIT_OK;
  }
  if (valg.synk) return synk(valg, bucket, rot, rotArg!, o);
  return publiser(valg, bucket, rot, oppgitt, stier, o);
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
