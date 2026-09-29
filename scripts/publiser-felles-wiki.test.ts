import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  erDatakontekst,
  gyldigKontrollsiffer11,
  gyldigOrgnr,
  harSignalNone,
  klassifiser11,
  masker,
  refererteBilder,
  sjekkSti,
  skannTekst,
  vurderFil,
} from "./publiser-felles-wiki.ts";

// Alle numre her er SYNTETISKE: de bygges fra kontrollsifferalgoritmen i
// testen selv. Ingen er hentet fra en ekte person.
function mod11(d: number[], w: number[]): number | null {
  const k = 11 - (w.reduce((a, x, i) => a + x * d[i]!, 0) % 11);
  return k === 11 ? 0 : k === 10 ? null : k;
}

/** Første gyldige 11-sifrede nummer for datoen, ved å prøve individnumre. */
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

/** Første gyldige organisasjonsnummer fra og med et 8-sifret prefiks. */
function lagOrgnr(prefiks8: string): string {
  for (let p = Number(prefiks8); p < Number(prefiks8) + 100; p++) {
    const d = [...String(p)].map(Number);
    const k = mod11(d, [3, 2, 7, 6, 5, 4, 3, 2]);
    if (k !== null) return String(p) + k;
  }
  throw new Error("fant ikke et gyldig organisasjonsnummer");
}

const FNR = lagNummer("150385");
const DNR = lagNummer("550385"); // dag 15 + 40
const ORGNR = lagOrgnr("91234567");

function ødelagtKontroll(nr: string): string {
  const siste = (Number(nr.at(-1)) + 1) % 10;
  return nr.slice(0, -1) + siste;
}

describe("kontrollsiffer og dato", () => {
  test("syntetisk fødselsnummer er gyldig", () => {
    expect(gyldigKontrollsiffer11(FNR)).toBe(true);
    expect(klassifiser11(FNR)).toBe("fødselsnummer");
  });
  test("syntetisk D-nummer klassifiseres som D-nummer", () => {
    expect(klassifiser11(DNR)).toBe("D-nummer");
  });
  test("feil andre kontrollsiffer flagges ikke", () => {
    expect(klassifiser11(ødelagtKontroll(FNR))).toBeNull();
  });
  test("feil første kontrollsiffer flagges ikke", () => {
    const d = [...FNR];
    d[9] = String((Number(d[9]) + 1) % 10);
    expect(klassifiser11(d.join(""))).toBeNull();
  });
  test("umulig dato flagges ikke selv med riktig kontrollsiffer", () => {
    expect(klassifiser11(lagNummer("311385"))).toBeNull(); // måned 13
    expect(klassifiser11(lagNummer("310485"))).toBeNull(); // 31. april
  });
  test("organisasjonsnummer med riktig og feil kontrollsiffer", () => {
    expect(gyldigOrgnr(ORGNR)).toBe(true);
    expect(gyldigOrgnr(ødelagtKontroll(ORGNR))).toBe(false);
  });
});

describe("skannTekst", () => {
  test("fødselsnummer i løpende tekst gir maskert funn", () => {
    const funn = skannTekst(`Tittel\n\nBrukeren har ${FNR} i saken.`);
    expect(funn).toHaveLength(1);
    expect(funn[0]).toMatchObject({ linje: 3, type: "fødselsnummer", ident: false });
    expect(funn[0]!.maskert).toBe("*********" + FNR.slice(-2));
    expect(funn[0]!.maskert).not.toContain(FNR.slice(0, 9));
  });
  test("fødselsnummer skrevet med mellomrom etter datoen fanges", () => {
    const funn = skannTekst(`nr ${FNR.slice(0, 6)} ${FNR.slice(6)}`);
    expect(funn.map((f) => f.type)).toEqual(["fødselsnummer"]);
  });
  test("D-nummer fanges", () => {
    expect(skannTekst(`D-nr: ${DNR}`).map((f) => f.type)).toEqual(["D-nummer"]);
  });
  test("tall med feil kontrollsiffer gir ingen funn", () => {
    expect(skannTekst(`id ${ødelagtKontroll(FNR)}`)).toEqual([]);
  });
  test("11 sifre inne i et lengre tall gir ingen funn", () => {
    expect(skannTekst(`1${FNR}2`)).toEqual([]);
  });

  describe("organisasjonsnummer — bare i datalignende kontekst", () => {
    test("i løpende tekst uten stikkord: ikke flagget", () => {
      expect(skannTekst(`Det kom ${ORGNR} brev i fjor.`)).toEqual([]);
    });
    test("med stikkord på linjen: flagget", () => {
      const funn = skannTekst(`Arbeidsgiver har orgnr ${ORGNR}.`);
      expect(funn.map((f) => f.type)).toEqual(["organisasjonsnummer"]);
      expect(funn[0]!.maskert).toBe("*******" + ORGNR.slice(-2));
    });
    test("i en tabellrad: flagget", () => {
      expect(skannTekst(`| Firma | ${ORGNR} |`).map((f) => f.type)).toEqual(["organisasjonsnummer"]);
    });
    test("i en kodeblokk: flagget", () => {
      const tekst = ["```", `${ORGNR}`, "```", `${ORGNR} utenfor`].join("\n");
      expect(skannTekst(tekst).map((f) => f.linje)).toEqual([2]);
    });
    test("på en JSON-lignende linje: flagget", () => {
      expect(skannTekst(`  "arbeidsgiver": "${ORGNR}",`)).toHaveLength(1);
    });
    test("feil kontrollsiffer i datakontekst: ikke flagget", () => {
      expect(skannTekst(`orgnr ${ødelagtKontroll(ORGNR)}`)).toEqual([]);
    });
    test("erDatakontekst direkte", () => {
      expect(erDatakontekst("Organisasjonsnummer: 1", false)).toBe(true);
      expect(erDatakontekst("vanlig tekst", false)).toBe(false);
      expect(erDatakontekst("vanlig tekst", true)).toBe(true);
    });
  });

  // Z99xxxx er testidentområdet, ikke en ekte saksbehandler.
  test("NAVident-lignende kode gir ident-funn", () => {
    const funn = skannTekst("Saksbehandler Z990123 godkjente.");
    expect(funn).toEqual([{ linje: 1, type: "NAVident", maskert: "*****23", ident: true, antall: 1 }]);
  });
  test("NAVident inne i et lengre ord gir ingen funn", () => {
    expect(skannTekst("abcZ990123 og Z9901234")).toEqual([]);
  });
  test("e-postadresse gir maskert ident-funn", () => {
    const funn = skannTekst("Kontakt ola.nordmann@example.no");
    expect(funn).toHaveLength(1);
    expect(funn[0]).toMatchObject({ type: "e-post", ident: true });
    expect(funn[0]!.maskert.endsWith("no")).toBe(true);
    expect(funn[0]!.maskert).not.toContain("nordmann");
  });
});

describe("masker", () => {
  test("viser bare de to siste tegnene", () => {
    expect(masker("12345678901")).toBe("*********01");
    expect(masker("ab")).toBe("**");
    expect(masker("123 456 789")).toBe("*******89");
  });
});

describe("harSignalNone", () => {
  test("signal: none i frontmatter", () => {
    expect(harSignalNone("---\ntitle: X\nsignal: none\n---\nTekst")).toBe(true);
    expect(harSignalNone('---\nsignal: "none"\n---\n')).toBe(true);
  });
  test("andre verdier, eller signal: none utenfor frontmatter", () => {
    expect(harSignalNone("---\nsignal: high\n---\n")).toBe(false);
    expect(harSignalNone("Tekst\n\nsignal: none\n")).toBe(false);
    expect(harSignalNone("---\ntitle: X\n---\nsignal: none\n")).toBe(false);
  });
});

describe("sjekkSti", () => {
  test("sider og roten sin .wiki-reader.json er tillatt", () => {
    for (const s of ["a.md", "plans/b.mdx", "c.html", "D.MD", ".wiki-reader.json"]) {
      expect(sjekkSti(s)).toBeNull();
    }
  });
  test("uttrekk avvises med egen melding", () => {
    for (const s of ["data.csv", "x/uttrekk.json", "ark.xlsx", "notat.txt"]) {
      expect(sjekkSti(s)).toContain("uttrekk");
    }
  });
  test("andre filtyper, skjulte filer og traversering avvises", () => {
    expect(sjekkSti("a.pdf")).toContain("ikke tillatt");
    expect(sjekkSti("README")).toContain("ikke tillatt");
    expect(sjekkSti("sub/.wiki-reader.json")).toContain("skjult");
    expect(sjekkSti(".git/config.md")).toContain("skjult");
    expect(sjekkSti("../a.md")).toContain("ut av");
    expect(sjekkSti("/abs.md")).not.toBeNull();
  });
});

describe("refererteBilder (brukes til en advarsel, bildene lastes ikke opp)", () => {
  test("relative bilder fra markdown og src, ikke URL-er eller absolutte stier", () => {
    const tekst = [
      "![diagram](bilder/flyt.png)",
      '![x](<med mellomrom.svg> "tittel")',
      '<img src="./a.jpg" />',
      "<Figure src={'fig.webp'} />",
      "![ekstern](https://example.no/b.png)",
      "![abs](/c.png)",
      "[lenke](side.mdx)",
    ].join("\n");
    expect(refererteBilder(tekst).sort()).toEqual(["./a.jpg", "bilder/flyt.png", "fig.webp", "med mellomrom.svg"].sort());
  });
});

describe("vurderFil", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-wiki-test-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const skriv = (rel: string, innhold: string) => {
    mkdirSync(path.dirname(path.join(rot, rel)), { recursive: true });
    writeFileSync(path.join(rot, rel), innhold);
    return path.join(rot, rel);
  };

  test("ren side består", () => {
    const abs = skriv("ren.mdx", "---\ntitle: Ren\n---\n# Ren side\n");
    expect(vurderFil(abs, "ren.mdx", false).avslag).toEqual([]);
  });
  test("side med fødselsnummer avvises med fil:linje og maskert verdi", () => {
    const abs = skriv("fnr.mdx", `# Side\n\n${FNR}\n`);
    const v = vurderFil(abs, "fnr.mdx", false);
    expect(v.avslag).toEqual([`fnr.mdx:3: fødselsnummer *********${FNR.slice(-2)}`]);
  });
  test("NAVident avvises uten --tillat-ident, advares med", () => {
    const abs = skriv("ident.md", "Z990123\n");
    expect(vurderFil(abs, "ident.md", false).avslag).toHaveLength(1);
    const v = vurderFil(abs, "ident.md", true);
    expect(v.avslag).toEqual([]);
    expect(v.advarsler).toHaveLength(1);
  });
  test("--tillat-ident slipper ikke gjennom fødselsnummer", () => {
    const abs = skriv("fnr2.md", `${FNR}\n`);
    expect(vurderFil(abs, "fnr2.md", true).avslag).toHaveLength(1);
  });
  test("signal: none avvises", () => {
    const abs = skriv("stille.mdx", "---\nsignal: none\n---\nx\n");
    expect(vurderFil(abs, "stille.mdx", false).avslag).toEqual(["siden er culled (`signal: none` eller wiki-signal=none)"]);
  });
  test("csv avvises uten å bli lest", () => {
    const abs = skriv("data.csv", `${FNR}\n`);
    const v = vurderFil(abs, "data.csv", false);
    expect(v.avslag).toHaveLength(1);
    expect(v.avslag[0]).toContain("uttrekk");
  });
});
