import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harSignalNone, klassifiser11, sjekkSti, skannTekst, vurderFil } from "./publiser-felles-wiki.ts";

// Alle numre her er SYNTETISKE: de bygges fra kontrollsifferalgoritmen i
// testen selv. Ingen er hentet fra en ekte person.
function mod11(d: number[], w: number[]): number | null {
  const k = 11 - (w.reduce((a, x, i) => a + x * d[i]!, 0) % 11);
  return k === 11 ? 0 : k === 10 ? null : k;
}

function lagNummer(ddmmyy: string, start = 500): string {
  for (let ind = start; ind < 1000; ind++) {
    const ni = ddmmyy + String(ind).padStart(3, "0");
    const d = [...ni].map(Number);
    const k1 = mod11(d, [3, 7, 6, 1, 8, 9, 4, 5, 2]);
    if (k1 === null) continue;
    const k2 = mod11([...d, k1], [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    if (k2 === null) continue;
    return ni + k1 + k2;
  }
  throw new Error("fant ikke et gyldig nummer");
}

function lagOrgnr(prefiks8: string): string {
  for (let p = Number(prefiks8); p < Number(prefiks8) + 100; p++) {
    const d = [...String(p)].map(Number);
    const k = mod11(d, [3, 2, 7, 6, 5, 4, 3, 2]);
    if (k !== null) return String(p) + k;
  }
  throw new Error("fant ikke et gyldig organisasjonsnummer");
}

const FNR = lagNummer("150385");
const DATO = FNR.slice(0, 6);
const PERS = FNR.slice(6);
const HNR_UMULIG = lagNummer("155385"); // måned 53 = 13 + 40, ingen gyldig måned
const HNR_GYLDIG = lagNummer("154385"); // måned 43 = 03 + 40
const SYNTETISK = lagNummer("158385"); // måned 83 = 03 + 80 (Tenor)
const ORGNR = lagOrgnr("91234567");

const typer = (tekst: string) => skannTekst(tekst).map((f) => f.type);

describe("fødselsnummer i realistiske skrivemåter", () => {
  test.each([
    ["punktum mellom dato og personnummer", `${DATO}.${PERS}`],
    ["bindestrek", `${DATO}-${PERS}`],
    ["mellomrom og bindestrek", `${DATO} -${PERS}`],
    ["hardt mellomrom (NBSP)", `${DATO}\u00a0${PERS}`],
    ["smalt mellomrom", `${DATO}\u202f${PERS}`],
    ["fullbredde-sifre", [...FNR].map((c) => String.fromCharCode(0xff10 + Number(c))).join("")],
    ["nullbredde-tegn inni", `${DATO.slice(0, 3)}\u200b${DATO.slice(3)}${PERS}`],
    ["myk bindestrek inni", `${DATO}\u00ad${PERS}`],
    ["HTML-entitet &nbsp;", `${DATO}&nbsp;${PERS}`],
    ["HTML-entitet numerisk", `${DATO}&#32;${PERS}`],
    ["HTML-entitet for sifre", [...FNR].map((c) => `&#${48 + Number(c)};`).join("")],
    ["DD.MM.ÅÅ NNNNN", `${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)} ${PERS}`],
    ["tabellceller", `| ${DATO} | ${PERS} |`],
    ["fet skrift splitter", `**${DATO}**${PERS}`],
    ["HTML-celler", `<td>${DATO}</td><td>${PERS}</td>`],
    ["grupper på tre", `${FNR.slice(0, 3)} ${FNR.slice(3, 6)} ${FNR.slice(6, 9)} ${FNR.slice(9)}`],
  ])("%s", (_navn, tekst) => {
    expect(typer(`Saken gjelder ${tekst} i dag.`)).toEqual(["fødselsnummer"]);
  });

  test.each([
    ["prettier-justert tabell", `| ${DATO}        | ${PERS}      |`],
    ["seks mellomrom", `${DATO}      ${PERS}`],
    ["&nbsp uten semikolon", `${DATO}&nbsp${PERS}`],
    ["Hangul-fyll U+3164", `${DATO}\u3164${PERS}`],
    ["Hangul-fyll U+115F", `${DATO}\u115f${PERS}`],
    ["Hangul-fyll U+1160", `${DATO}\u1160${PERS}`],
    ["halvbredde Hangul-fyll U+FFA0", `${DATO}\uffa0${PERS}`],
  ])("runde 2: %s", (_navn, tekst) => {
    expect(typer(`Saken gjelder ${tekst} i dag.`)).toEqual(["fødselsnummer"]);
  });

  test("HTML med én celle per linje", () => {
    expect(skannTekst(`<tr>\n<td>${DATO}</td>\n<td>${PERS}</td>\n</tr>`).map((f) => [f.type, f.linje])).toEqual([["fødselsnummer", 2]]);
    expect(typer(`  <td>${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)}</td>\n  <td>${PERS}</td>`)).toEqual(["fødselsnummer"]);
    // Et nummer som alt står helt på én linje, telles ikke én gang til av rekken.
    expect(skannTekst(`<td>${FNR}</td>\n<td>42</td>`).map((f) => f.antall)).toEqual([1]);
    // En tallkolonne uten tagger slås ikke sammen over linjer.
    expect(typer(`${DATO}\n${PERS}`)).toEqual([]);
  });

  test("grensen for mellomrommet: 5 tegn slås sammen, 6 gjør det ikke", () => {
    expect(typer(`${DATO}-.-.-${PERS}`)).toEqual(["fødselsnummer"]);
    expect(typer(`${DATO}-.-.-.${PERS}`)).toEqual([]);
  });

  test("en HTML-tagg teller som nøyaktig ett tegn", () => {
    expect(typer(`${DATO}.-.-<span class="x">${PERS}`)).toEqual(["fødselsnummer"]);
    expect(typer(`${DATO}.-.-.<b>${PERS}`)).toEqual([]);
  });

  test("projeksjonen slår ikke sammen over ord, og krever gyldige kontrollsifre", () => {
    expect(typer(`| ${DATO} | ${PERS} |`)).toEqual(["fødselsnummer"]);
    expect(typer(`${DATO} og ${PERS}`)).toEqual([]);
    const feil = FNR.slice(0, 10) + String((Number(FNR[10]) + 1) % 10);
    expect(typer(`| ${feil.slice(0, 6)} | ${feil.slice(6)} |`)).toEqual([]);
  });
});

describe("H-nummer og syntetiske numre", () => {
  test("måned + 40 er et H-nummer og flagges; umulig måned og måned + 80 flagges ikke", () => {
    expect(klassifiser11(HNR_GYLDIG)).toBe("H-nummer");
    expect(typer(`nr ${HNR_GYLDIG}`)).toEqual(["H-nummer"]);
    expect(klassifiser11(HNR_UMULIG)).toBeNull();
    expect(klassifiser11(SYNTETISK)).toBeNull();
  });
});

describe("NAVident og duplikater", () => {
  test("nullbredde-tegn inni en NAVident fjernes før skanning", () => {
    expect(typer("Z99\u200b0123 og Z99\u00ad0124")).toEqual(["NAVident", "NAVident"]);
  });
  test("liten bokstav + 6 sifre (git-SHA) er ikke en NAVident, stor bokstav er det", () => {
    expect(typer("commit a123456 og e654321 er slått sammen")).toEqual([]);
    expect(typer("Z990123")).toEqual(["NAVident"]);
  });
  test("samme verdi i samme fil rapporteres én gang med antall", () => {
    const funn = skannTekst(`Z990123\nx\nZ990123 og Z990123`);
    expect(funn).toHaveLength(1);
    expect(funn[0]).toMatchObject({ linje: 1, type: "NAVident" });
    expect((funn[0] as unknown as { antall: number }).antall).toBe(3);
  });
});

describe("organisasjonsnummer", () => {
  test("foretaksnummer som stikkord", () => {
    expect(typer(`Foretaksnummer ${ORGNR}`)).toEqual(["organisasjonsnummer"]);
  });
  test("HTML-celle", () => {
    expect(typer(`<td>${ORGNR}</td>`)).toEqual(["organisasjonsnummer"]);
  });
  test("YAML-liste", () => {
    expect(typer(`  - ${ORGNR}`)).toEqual(["organisasjonsnummer"]);
  });
  test("YAML-nøkkel med norsk bokstav", () => {
    expect(typer(`  arbeidsgiverNær: ${ORGNR}`)).toEqual(["organisasjonsnummer"]);
  });
  test("punktum- og mellomromsgrupper", () => {
    const [a, b, c] = [ORGNR.slice(0, 3), ORGNR.slice(3, 6), ORGNR.slice(6)];
    expect(typer(`orgnr ${a}.${b}.${c}`)).toEqual(["organisasjonsnummer"]);
    expect(typer(`orgnr ${a}\u00a0${b}\u00a0${c}`)).toEqual(["organisasjonsnummer"]);
    expect(typer(`orgnr ${a}\t${b}\t${c}`)).toEqual(["organisasjonsnummer"]);
  });
  test("et ```-gjerde inne i en ````-blokk snur ikke tilstanden", () => {
    const tekst = ["````", "```", "````", `Det kom ${ORGNR} brev.`].join("\n");
    expect(typer(tekst)).toEqual([]);
  });
  test("et lukkegjerde med info-streng lukker ikke blokken", () => {
    const tekst = ["```", "```js", `Det kom ${ORGNR} brev.`, "```"].join("\n");
    expect(skannTekst(tekst).map((f) => f.linje)).toEqual([3]);
  });
  test("``` med backtick i info-strengen åpner ingen blokk", () => {
    const tekst = ["```x`y", `Det kom ${ORGNR} brev.`].join("\n");
    expect(typer(tekst)).toEqual([]);
  });
  test("org-stikkord med mellomrom og bindestrek virker fortsatt", () => {
    expect(typer(`org   -  nr ${ORGNR}`)).toEqual(["organisasjonsnummer"]);
    expect(typer(`virksomhets - nummer ${ORGNR}`)).toEqual(["organisasjonsnummer"]);
  });
  test("~~~ lukker ikke en ```-blokk", () => {
    const tekst = ["```", "~~~", `${ORGNR}`, "```"].join("\n");
    expect(skannTekst(tekst).map((f) => f.linje)).toEqual([3]);
  });
});

describe("e-post er lineær", () => {
  test("1 MB på én linje uten @ skannes på under ett sekund", () => {
    const linje = "a".repeat(1024 * 1024);
    const t0 = performance.now();
    expect(skannTekst(linje)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(typer("skriv til ola.nordmann@example.no i dag")).toEqual(["e-post"]);
  });
});

describe("stikkordene for organisasjonsnummer er lineære", () => {
  test.each([["org"], ["virksomhets"], ["foretaks.-"]])("%s + 1 MB mellomrom skannes på under ett sekund", (start) => {
    const linje = start + " ".repeat(1024 * 1024);
    const t0 = performance.now();
    expect(skannTekst(linje)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("e-post med Unicode-bindestrek i domenet", () => {
  test("U+2010 i domenet blir `-`, og hele adressen fanges", () => {
    const funn = skannTekst("skriv til ola@nav\u2010test.example i dag");
    expect(funn.map((f) => [f.type, f.maskert])).toEqual([["e-post", "*".repeat(18) + "le"]]);
  });
});

describe("signal: none", () => {
  test("HTML-meta wiki-signal=none", () => {
    expect(harSignalNone('<html><head><meta name="wiki-signal" content="none"></head></html>', true)).toBe(true);
    expect(harSignalNone("<meta content='none' name='wiki-signal'>", true)).toBe(true);
    expect(harSignalNone('<meta name="wiki-signal-reason" content="none">', true)).toBe(false);
    // En markdown-side som omtaler HTML-formen i teksten, er ikke culled.
    expect(harSignalNone('Bruk `<meta name="wiki-signal" content="none">` i HTML.', false)).toBe(false);
  });
  test("store bokstaver og blank linje før frontmatter", () => {
    expect(harSignalNone("---\nSignal: None\n---\n")).toBe(true);
    expect(harSignalNone("\n---\nsignal: none\n---\nx")).toBe(true);
  });
});

describe("sjekkSti — speilets øvrige avslag", () => {
  test("bilder avvises", () => {
    for (const s of ["a.png", "b/c.JPG", "d.svg", "e.webp"]) expect(sjekkSti(s)).toContain("bilde");
  });
  test("jokertegn avvises", () => {
    for (const s of ["a[1].md", "b*.md", "c?.md", "d]x.md"]) expect(sjekkSti(s)).toContain("jokertegn");
  });
  test("kontroll- og retningstegn avvises", () => {
    for (const c of ["\u0007", "\u0085", "\u2028", "\u202e", "\u2067"]) expect(sjekkSti(`a${c}b.md`)).toContain("kontrolltegn");
  });
  test("segment over 211 byte avvises, 211 byte slipper", () => {
    expect(sjekkSti(`${"a".repeat(209)}.md`)).toContain("211"); // 212 byte
    expect(sjekkSti(`${"a".repeat(208)}.md`)).toBeNull(); // 211 byte
    expect(sjekkSti(`${"ø".repeat(105)}.md`)).toContain("211"); // 210 + 3 byte
  });
});

describe("vurderFil", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-wiki-skanner-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const skriv = (rel: string, innhold: string | Uint8Array) => {
    writeFileSync(path.join(rot, rel), innhold);
    return path.join(rot, rel);
  };

  test("fødselsnummer i filnavnet avvises, og navnet skrives aldri helt ut", () => {
    const rel = `sak-${FNR}.md`;
    const v = vurderFil(skriv(rel, "# Ren tekst\n"), rel, true);
    expect(v.avslag.length).toBeGreaterThan(0);
    expect([...v.avslag, ...v.advarsler].join("\n")).not.toContain(FNR);
  });
  test("grensen er 2 MB, som speilet", () => {
    const over = Buffer.alloc(2 * 1024 * 1024 + 1, "aaaaaaa\n"); // mange linjer: skannet er ikke det som måles
    expect(vurderFil(skriv("stor.md", over), "stor.md", false).avslag.join(" ")).toContain("2097152");
    const akkurat = Buffer.alloc(2 * 1024 * 1024, "aaaaaaa\n");
    expect(vurderFil(skriv("grense.md", akkurat), "grense.md", false).avslag).toEqual([]);
  });
  test.each([
    ["UTF-16LE med merke", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("skriv til ola@example.no\n", "utf16le")])],
    ["UTF-16BE med merke", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("skriv til ola@example.no\n", "utf16le").swap16()])],
    ["UTF-16LE uten merke", Buffer.from("skriv til ola@example.no\n", "utf16le")],
    ["UTF-32BE med merke", Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61])],
  ])("%s avvises", (_navn, bytes) => {
    const v = vurderFil(skriv("utf16.md", bytes), "utf16.md", false);
    expect(v.avslag.join(" ")).toMatch(/UTF-16|UTF-32|NUL/);
    expect(v.bytes).toBeUndefined();
  });

  test("HTML-side med wiki-signal=none avvises", () => {
    const rel = "stille.html";
    const v = vurderFil(skriv(rel, '<html><head><meta name="wiki-signal" content="none"></head><body>x</body></html>'), rel, false);
    expect(v.avslag.join(" ")).toContain("signal");
  });
});
