import { describe, expect, test } from "bun:test";
import { scanAnswer } from "./svar-skanner.ts";

// Alle numre her er SYNTETISKE: de bygges fra kontrollsifferalgoritmen i
// testen selv. Ingen er hentet fra en ekte person. Generatorene er de samme
// som i scripts/publiser-felles-wiki.skanner.test.ts.
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
const DNR = lagNummer("550385"); // dag 55 = 15 + 40
const HNR = lagNummer("154385"); // måned 43 = 03 + 40
const ORGNR = lagOrgnr("91234567");

const mellomrom = (nr: string) => `${nr.slice(0, 6)} ${nr.slice(6)}`;
const punktum = (nr: string) => `${nr.slice(0, 2)}.${nr.slice(2, 4)}.${nr.slice(4, 6)} ${nr.slice(6)}`;
const fullbredde = (nr: string) => [...nr].map((c) => String.fromCharCode(0xff10 + Number(c))).join("");

describe("scanAnswer avviser", () => {
  test.each([
    ["fødselsnummer sammenhengende", FNR, "fødselsnummer", FNR],
    ["fødselsnummer ddmmåå nnnnn", mellomrom(FNR), "fødselsnummer", FNR],
    ["fødselsnummer dd.mm.åå nnnnn", punktum(FNR), "fødselsnummer", FNR],
    ["fødselsnummer med fullbredde-sifre", fullbredde(FNR), "fødselsnummer", FNR],
    ["D-nummer ddmmåå nnnnn", mellomrom(DNR), "D-nummer", DNR],
    ["D-nummer dd.mm.åå nnnnn", punktum(DNR), "D-nummer", DNR],
    ["H-nummer ddmmåå nnnnn", mellomrom(HNR), "H-nummer", HNR],
    ["H-nummer dd.mm.åå nnnnn", punktum(HNR), "H-nummer", HNR],
  ])("%s", (_navn, skrevet, type, nr) => {
    const svar = scanAnswer(`Første linje er ren.\nSaken gjelder ${skrevet} i dag.`);
    expect(svar).toEqual([{ reason: `linje 2: ${type} *********${nr.slice(-2)}` }]);
  });

  test("organisasjonsnummer på en nøkkel-verdi-linje", () => {
    expect(scanAnswer(`Arbeidsgiver er oppgitt.\norgnr: ${ORGNR}`)).toEqual([{ reason: `linje 2: organisasjonsnummer *******${ORGNR.slice(-2)}` }]);
  });

  test("samme nummer flere ganger gir ett avslag med antall", () => {
    expect(scanAnswer(`${FNR}\nog igjen ${FNR}`)).toEqual([{ reason: `linje 1: fødselsnummer *********${FNR.slice(-2)} (2 forekomster)` }]);
  });

  test("et avslag på et fødselsnummer står selv om svaret også har en NAVident", () => {
    expect(scanAnswer(`Z990001 sjekket ${FNR}`).map((a) => a.reason)).toEqual([`linje 1: fødselsnummer *********${FNR.slice(-2)}`]);
  });

  test("grunnen inneholder aldri hele nummeret", () => {
    const alle = [FNR, mellomrom(FNR), punktum(FNR), fullbredde(FNR), DNR, HNR, `orgnr: ${ORGNR}`].join("\n");
    const grunner = scanAnswer(alle).map((a) => a.reason).join("\n");
    expect(grunner).not.toBe("");
    for (const nr of [FNR, DNR, HNR, ORGNR]) {
      expect(grunner).not.toContain(nr);
      expect(grunner).not.toContain(nr.slice(0, 6));
    }
  });
});

describe("scanAnswer slipper gjennom", () => {
  test.each([
    ["NAVident", "Z990001 kan svare på dette."],
    ["e-post", "Spør fornavn.etternavn@example.no om saken."],
    ["ren tekst over flere linjer", "Ja, det stemmer.\n\nRegelen gjelder fra 1. januar 2024,\nog unntaket i punkt 3 gjelder fortsatt."],
    ["tom tekst", ""],
  ])("%s", (_navn, tekst) => {
    expect(scanAnswer(tekst)).toEqual([]);
  });
});

test("resultatet er en vanlig liste av { reason }-objekter", () => {
  const svar = scanAnswer(FNR);
  expect(Array.isArray(svar)).toBe(true);
  expect(Object.getPrototypeOf(svar)).toBe(Array.prototype);
  for (const a of svar) {
    expect(Object.keys(a)).toEqual(["reason"]);
    expect(typeof a.reason).toBe("string");
  }
});

test("en verdi som ikke er en streng, kaster", () => {
  expect(() => scanAnswer(undefined as unknown as string)).toThrow(TypeError);
});
