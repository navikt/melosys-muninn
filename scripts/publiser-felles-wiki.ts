#!/usr/bin/env bun
/**
 * Publiserer sider fra en lokal wiki-mappe til felles-wiki-bøtta, som
 * melosys-muninn-q2 speiler og viser skrivebeskyttet på
 * /wiki?wiki=melosys-felles.
 *
 *   bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] <wiki-rot> <relPath>...
 *
 * Hver fil sjekkes før opplasting, og en fil som feiler sjekken lastes ikke opp:
 *   - filtype: .md .mdx .html, bilder (.png .jpg .jpeg .gif .svg .webp) og
 *     `.wiki-reader.json` på rotnivå. Alt annet avvises, uttrekk (.csv .json
 *     .xlsx .txt) med egen melding. Reglene er de samme som speilet i muninn
 *     bruker, så en fil som slipper gjennom her, blir også vist i poden.
 *   - identifikatorer: fødselsnummer og D-nummer (kontrollsiffer + dato),
 *     organisasjonsnummer (kontrollsiffer, bare i datalignende kontekst — se
 *     `erDatakontekst`), e-postadresser og NAVident-lignende koder. De to siste
 *     avvises også, med mindre `--tillat-ident` er gitt. Funn skrives med fil,
 *     linje og type, og verdien er maskert til de to siste tegnene.
 *   - frontmatter med `signal: none` avvises.
 *
 * Bøtte: `--bucket`, ellers FELLES_WIKI_BUCKET, ellers `felles_wiki_bucket` i
 * nais/vars-q2.json. Ingen avhengigheter utover Bun og `gcloud`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const SIDE_ENDELSER = new Set([".md", ".mdx", ".html"]);
export const BILDE_ENDELSER = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
export const UTTREKK_ENDELSER = new Set([".csv", ".json", ".xlsx", ".txt"]);
export const LESER_KONFIG = ".wiki-reader.json";
/** Speilet i muninn hopper over objekter over denne størrelsen. */
export const MAKS_BYTES = 5 * 1024 * 1024;

export type FunnType = "fødselsnummer" | "D-nummer" | "organisasjonsnummer" | "e-post" | "NAVident";

export interface Funn {
  linje: number;
  type: FunnType;
  maskert: string;
  /** e-post og NAVident — avvises bare uten --tillat-ident. */
  ident: boolean;
}

/** Alle tegn unntatt de to siste blir `*`. */
export function masker(verdi: string): string {
  const v = verdi.replace(/\s/g, "");
  if (v.length <= 2) return "*".repeat(v.length);
  return "*".repeat(v.length - 2) + v.slice(-2);
}

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
 * Fødselsnummer, D-nummer eller ingen av delene. D-nummer har 4 lagt til
 * første siffer (dag + 40). Datoen sjekkes mot månedslengde, med 29. februar
 * alltid tillatt — århundret følger av individnummeret, og en litt for vid
 * datosjekk avviser heller for mye enn for lite.
 */
export function klassifiser11(nr: string): "fødselsnummer" | "D-nummer" | null {
  if (!gyldigKontrollsiffer11(nr)) return null;
  let dag = Number(nr.slice(0, 2));
  const måned = Number(nr.slice(2, 4));
  let type: "fødselsnummer" | "D-nummer" = "fødselsnummer";
  if (dag > 40) {
    dag -= 40;
    type = "D-nummer";
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

const ORG_ORD = /org(anisasjons)?\.?\s*-?\s*(nr|nummer)|orgnr|virksomhetsnummer|\borgnum/i;

/**
 * Når et gyldig 9-sifret tall regnes som et organisasjonsnummer. Et tall med
 * riktig kontrollsiffer alene er for vanlig (omtrent hvert ellevte tall), så
 * det kreves i tillegg ett av:
 *   - et ord som orgnr/organisasjonsnummer/virksomhetsnummer på samme linje,
 *   - en tabellrad (linjen starter med `|`),
 *   - en linje inne i en kodeblokk (``` eller ~~~),
 *   - en JSON-/nøkkel-verdi-lignende linje (`"felt": …` eller `felt: …`).
 */
export function erDatakontekst(linje: string, iKodeblokk: boolean): boolean {
  if (iKodeblokk) return true;
  if (ORG_ORD.test(linje)) return true;
  const t = linje.trim();
  if (t.startsWith("|")) return true;
  if (/["'][^"']*["']\s*:/.test(t)) return true;
  if (/^[A-Za-z_][\w.-]*\s*[:=]\s*["']?\d/.test(t)) return true;
  return false;
}

const RE_11 = /(?<![\d])(\d{6})[ ]?(\d{5})(?![\d])/g;
const RE_9 = /(?<![\d])(\d{3})[ ]?(\d{3})[ ]?(\d{3})(?![\d])/g;
const RE_EPOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_NAVIDENT = /(?<![A-Za-z0-9])[A-Za-z]\d{6}(?![A-Za-z0-9])/g;

/** Skanner tekst linje for linje og returnerer alle funn. */
export function skannTekst(tekst: string): Funn[] {
  const funn: Funn[] = [];
  let iKodeblokk = false;
  const linjer = tekst.split(/\r?\n/);
  for (let i = 0; i < linjer.length; i++) {
    const linje = linjer[i]!;
    const nr = i + 1;
    const erGjerde = /^\s*(```|~~~)/.test(linje);
    if (erGjerde) {
      iKodeblokk = !iKodeblokk;
      continue;
    }
    for (const m of linje.matchAll(RE_11)) {
      const tall = m[1]! + m[2]!;
      const type = klassifiser11(tall);
      if (type) funn.push({ linje: nr, type, maskert: masker(tall), ident: false });
    }
    if (erDatakontekst(linje, iKodeblokk)) {
      for (const m of linje.matchAll(RE_9)) {
        const tall = m[1]! + m[2]! + m[3]!;
        if (gyldigOrgnr(tall)) funn.push({ linje: nr, type: "organisasjonsnummer", maskert: masker(tall), ident: false });
      }
    }
    for (const m of linje.matchAll(RE_EPOST)) {
      funn.push({ linje: nr, type: "e-post", maskert: masker(m[0]), ident: true });
    }
    for (const m of linje.matchAll(RE_NAVIDENT)) {
      funn.push({ linje: nr, type: "NAVident", maskert: masker(m[0]), ident: true });
    }
  }
  return funn;
}

/** `signal: none` i frontmatter (blokken mellom de to første `---`-linjene). */
export function harSignalNone(tekst: string): boolean {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(tekst);
  if (!m) return false;
  return /^signal:\s*["']?none["']?\s*(#.*)?$/m.test(m[1]!);
}

/**
 * Avslag på grunn av sti eller filtype, eller null når stien er tillatt.
 * `rel` er posix-relativ til wiki-roten.
 */
export function sjekkSti(rel: string): string | null {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return "ugyldig sti";
  const deler = rel.split("/");
  if (deler.some((d) => d === "" || d === "." || d === "..")) return "stien peker ut av wiki-roten";
  if (rel === LESER_KONFIG) return null;
  if (deler.some((d) => d.startsWith("."))) return "skjult fil eller mappe";
  const ext = path.posix.extname(rel).toLowerCase();
  if (UTTREKK_ENDELSER.has(ext)) return `filtypen ${ext} er et uttrekk og publiseres aldri`;
  if (!SIDE_ENDELSER.has(ext) && !BILDE_ENDELSER.has(ext)) return `filtypen ${ext || "(ingen)"} er ikke tillatt`;
  return null;
}

/** Filer som skannes som tekst. SVG er tekst og kan bære navn og nummer. */
export function erTekst(rel: string): boolean {
  const ext = path.posix.extname(rel).toLowerCase();
  return rel === LESER_KONFIG || SIDE_ENDELSER.has(ext) || ext === ".svg";
}

/** Relative bildestier en side refererer til (markdown, `<img src>`, `src=`). */
export function refererteBilder(tekst: string): string[] {
  const ut = new Set<string>();
  const kandidater: string[] = [];
  for (const m of tekst.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g)) kandidater.push((m[1] ?? m[2])!);
  for (const m of tekst.matchAll(/\bsrc\s*=\s*\{?\s*["']([^"']+)["']/g)) kandidater.push(m[1]!);
  for (const k of kandidater) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(k) || k.startsWith("/") || k.startsWith("#")) continue;
    let ren: string;
    try {
      ren = decodeURI(k.split(/[?#]/)[0]!);
    } catch {
      continue;
    }
    if (BILDE_ENDELSER.has(path.posix.extname(ren).toLowerCase())) ut.add(ren);
  }
  return [...ut];
}

export interface Vurdering {
  rel: string;
  avslag: string[];
  advarsler: string[];
}

/** Vurderer én fil på disk. `abs` må ligge under roten. */
export function vurderFil(abs: string, rel: string, tillatIdent: boolean): Vurdering {
  const v: Vurdering = { rel, avslag: [], advarsler: [] };
  const sti = sjekkSti(rel);
  if (sti) {
    v.avslag.push(sti);
    return v;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    v.avslag.push("filen finnes ikke");
    return v;
  }
  const størrelse = statSync(abs).size;
  if (størrelse > MAKS_BYTES) v.avslag.push(`filen er større enn ${MAKS_BYTES} byte og ville blitt hoppet over av speilet`);
  if (!erTekst(rel)) {
    v.advarsler.push("bilder skannes ikke for personopplysninger — se over bildet selv");
    return v;
  }
  const tekst = readFileSync(abs, "utf8");
  if (harSignalNone(tekst)) v.avslag.push("frontmatter har `signal: none`");
  for (const f of skannTekst(tekst)) {
    const linje = `${rel}:${f.linje}: ${f.type} ${f.maskert}`;
    if (f.ident && tillatIdent) v.advarsler.push(`${linje} (tillatt med --tillat-ident)`);
    else v.avslag.push(f.ident ? `${linje} (bruk --tillat-ident hvis dette er med vilje)` : linje);
  }
  return v;
}

interface Valg {
  dryRun: boolean;
  tillatIdent: boolean;
  bucket?: string;
  rot?: string;
  stier: string[];
}

function lesArgs(argv: string[]): Valg | string {
  const v: Valg = { dryRun: false, tillatIdent: false, stier: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") v.dryRun = true;
    else if (a === "--tillat-ident") v.tillatIdent = true;
    else if (a === "--bucket") {
      const b = argv[++i];
      if (!b) return "--bucket mangler verdi";
      v.bucket = b;
    } else if (a.startsWith("--bucket=")) v.bucket = a.slice("--bucket=".length);
    else if (a === "-h" || a === "--help") return "";
    else if (a.startsWith("-")) return `ukjent flagg: ${a}`;
    else if (!v.rot) v.rot = a;
    else v.stier.push(a);
  }
  if (!v.rot || v.stier.length === 0) return "mangler wiki-rot eller relPath";
  return v;
}

const BRUK = "Bruk: bun scripts/publiser-felles-wiki.ts [--dry-run] [--tillat-ident] [--bucket <navn>] <wiki-rot> <relPath>...";

function lesVars(): Record<string, unknown> {
  const fil = path.join(import.meta.dir, "..", "nais", "vars-q2.json");
  try {
    return JSON.parse(readFileSync(fil, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Relativ posix-sti under roten, eller null når `abs` ligger utenfor. En fil
 * som finnes, måles etter at symlenker er løst opp, så en lenke ut av roten
 * ikke slipper gjennom.
 */
function relUnder(rot: string, abs: string): string | null {
  const r = path.relative(rot, existsSync(abs) ? realpathSync(abs) : abs);
  if (r === "" || r.startsWith("..") || path.isAbsolute(r)) return null;
  return r.split(path.sep).join("/");
}

function main(): number {
  const valg = lesArgs(process.argv.slice(2));
  if (typeof valg === "string") {
    if (valg) console.error(`Feil: ${valg}`);
    console.error(BRUK);
    return valg ? 2 : 0;
  }
  const vars = lesVars();
  const bucket = valg.bucket ?? process.env.FELLES_WIKI_BUCKET ?? (typeof vars.felles_wiki_bucket === "string" ? vars.felles_wiki_bucket : undefined);
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
    console.error(`Feil: ingen gyldig bøtte (fikk ${JSON.stringify(bucket ?? null)}). Bruk --bucket eller FELLES_WIKI_BUCKET.`);
    return 2;
  }
  const ingress = typeof vars.ingress_intern === "string" ? vars.ingress_intern : "https://melosys-muninn-q2.intern.dev.nav.no";
  const oppgitt = path.resolve(valg.rot!);
  if (!existsSync(oppgitt) || !statSync(oppgitt).isDirectory()) {
    console.error(`Feil: wiki-roten ${oppgitt} finnes ikke eller er ikke en mappe`);
    return 2;
  }
  const rot = realpathSync(oppgitt);

  const vurderinger: Vurdering[] = [];
  const sett = new Set<string>();
  const vurder = (abs: string, rel: string) => {
    if (sett.has(rel)) return undefined;
    sett.add(rel);
    const v = vurderFil(abs, rel, valg.tillatIdent);
    vurderinger.push(v);
    return v;
  };

  for (const s of valg.stier) {
    const abs = path.resolve(rot, s);
    const rel = relUnder(rot, abs);
    if (!rel) {
      vurderinger.push({ rel: s, avslag: ["stien ligger utenfor wiki-roten"], advarsler: [] });
      continue;
    }
    const v = vurder(abs, rel);
    if (!v || v.avslag.length > 0 || !SIDE_ENDELSER.has(path.posix.extname(rel).toLowerCase())) continue;
    // Bilder siden viser, men bare fra en side som selv besto.
    for (const bilde of refererteBilder(readFileSync(abs, "utf8"))) {
      const bAbs = path.resolve(path.dirname(abs), bilde);
      const bRel = relUnder(rot, bAbs);
      if (!bRel) {
        v.advarsler.push(`bildet ${bilde} ligger utenfor wiki-roten og lastes ikke opp`);
        continue;
      }
      if (!existsSync(bAbs)) {
        v.advarsler.push(`bildet ${bRel} finnes ikke lokalt`);
        continue;
      }
      vurder(bAbs, bRel);
    }
  }

  const godkjent = vurderinger.filter((v) => v.avslag.length === 0);
  const avvist = vurderinger.filter((v) => v.avslag.length > 0);
  for (const v of vurderinger) {
    console.log(`${v.avslag.length ? "AVVIST " : "OK     "} ${v.rel}`);
    for (const a of v.avslag) console.log(`    avslag: ${a}`);
    for (const a of v.advarsler) console.log(`    advarsel: ${a}`);
  }

  if (valg.dryRun) for (const v of godkjent) console.log(`vil laste opp gs://${bucket}/${v.rel}`);
  if (godkjent.length > 0 && !valg.dryRun) {
    const gcloud = Bun.which("gcloud");
    if (!gcloud) {
      console.error("Feil: finner ikke gcloud på PATH — ingenting er lastet opp");
      return 2;
    }
    for (const v of godkjent) {
      const mål = `gs://${bucket}/${v.rel}`;
      const r = Bun.spawnSync([gcloud, "storage", "cp", path.join(rot, v.rel), mål], { stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) {
        console.error(`Feil: opplasting av ${v.rel} til ${mål} feilet (exit ${r.exitCode})`);
        return 1;
      }
      console.log(`lastet opp ${mål}`);
    }
  }

  const sider = godkjent.filter((v) => SIDE_ENDELSER.has(path.posix.extname(v.rel).toLowerCase()));
  if (sider.length > 0) {
    console.log(valg.dryRun ? "\nTørrkjøring — ingenting er lastet opp. Adresser etter publisering:" : "\nPublisert. Speilet i poden henter endringer omtrent hvert 2. minutt:");
    for (const v of sider) console.log(`  ${ingress}/wiki?wiki=melosys-felles&relPath=${encodeURIComponent(v.rel)}`);
  }
  if (avvist.length > 0) {
    console.log(`\n${avvist.length} fil(er) avvist og ikke lastet opp.`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main());
