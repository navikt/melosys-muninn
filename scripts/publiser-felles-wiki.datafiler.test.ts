// Datafilene en side viser: porten av muninns regel, kolonnene med NAVident
// som fjernes fra en CSV-kopi, og vurderingen av datafiler. Alle verdier er
// syntetiske.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fjernIdentKolonner, navngitteDatafiler, vurderFil } from "./publiser-felles-wiki.ts";
import fasit from "./publiser-felles-wiki.datafiler.cases.json";

// Syntetisk fødselsnummer, bygget fra kontrollsifferalgoritmen.
function lagNummer(ddmmyy: string): string {
  const mod11 = (d: number[], w: number[]) => {
    const k = 11 - (w.reduce((a, x, i) => a + x * d[i]!, 0) % 11);
    return k === 11 ? 0 : k === 10 ? null : k;
  };
  for (let ind = 500; ind < 1000; ind++) {
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
const FNR = lagNummer("150385");

describe("navngitteDatafiler følger muninns regel (fasiten fra muninn)", () => {
  const utfall = { ok: "ok", ugyldig: "invalid", filtype: "extension" } as const;
  for (const c of fasit.cases) {
    test(c.name, () => {
      const faktisk: unknown = navngitteDatafiler(c.page, c.markdown).map((d) => ({ ref: d.ref, kinds: d.typer, lexical: utfall[d.utfall], rel: d.rel }));
      expect(faktisk).toEqual(c.refs);
    });
  }

  // muninn tester sin egen regel mot src/wiki/page-file-refs.cases.json. Med
  // MUNINN_KILDE satt til en muninn-arbeidskopi sjekkes det at kopien her er lik.
  const kilde = process.env.MUNINN_KILDE?.trim();
  test.skipIf(!kilde)("fasiten er lik muninns kopi (MUNINN_KILDE)", () => {
    const muninn = path.join(kilde!, "src", "wiki", "page-file-refs.cases.json");
    expect(existsSync(muninn)).toBe(true);
    expect(readFileSync(path.join(import.meta.dir, "publiser-felles-wiki.datafiler.cases.json"), "utf8")).toBe(readFileSync(muninn, "utf8"));
  });
});

describe("fjernIdentKolonner", () => {
  test("fjerner kolonnen med NAVident i alle rader og beholder resten", () => {
    const csv = "id,endret_av,status\n1,Z990123,OK\n2,Z990124,AVSLUTTET\n";
    expect(fjernIdentKolonner(csv)).toEqual({
      tekst: "id,status\n1,OK\n2,AVSLUTTET\n",
      fjernet: [{ navn: "endret_av", rader: 2 }],
    });
  });

  test("felt i anførselstegn med komma, linjeskift og \"\" holder kolonnene på plass", () => {
    const csv = 'id,notat,saksbehandler\r\n1,"a, b\r\nfortsatt notat","Z990123"\r\n2,"sa ""hei""",\r\n';
    expect(fjernIdentKolonner(csv)).toEqual({
      tekst: 'id,notat\r\n1,"a, b\r\nfortsatt notat"\r\n2,"sa ""hei"""\r\n',
      fjernet: [{ navn: "saksbehandler", rader: 1 }],
    });
  });

  test("en NAVident i fritekst fjerner hele kolonnen; flere kolonner, BOM og fil uten avsluttende linjeskift", () => {
    const csv = "﻿a,b,c,d\nZ990123,x,endret av Z990124 i går,y";
    expect(fjernIdentKolonner(csv)).toEqual({
      tekst: "﻿b,d\nx,y",
      fjernet: [{ navn: "a", rader: 1 }, { navn: "c", rader: 1 }],
    });
  });

  test("en overskrift som selv er en NAVident, vises som kolonnenummer", () => {
    const r = fjernIdentKolonner("id,Z990123\n1,2\n");
    expect(r).toEqual({ tekst: "id\n1\n", fjernet: [{ navn: "kolonne nr. 2", rader: 1 }] });
  });

  test("uten treff er teksten uendret; et anførselstegn som aldri lukkes, gir en grunn", () => {
    expect(fjernIdentKolonner("a,b\n1,2\n")).toEqual({ tekst: "a,b\n1,2\n", fjernet: [] });
    expect(typeof fjernIdentKolonner('a,b\n1,"Z990123\n')).toBe("string");
  });
});

describe("vurderFil for en datafil", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-datafiler-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const skriv = (rel: string, innhold: string) => {
    mkdirSync(path.dirname(path.join(rot, rel)), { recursive: true });
    writeFileSync(path.join(rot, rel), innhold);
    return path.join(rot, rel);
  };

  test("CSV: kolonnen med NAVident fjernes fra kopien, kopien skannes, og kildefilen er uendret", () => {
    const kilde = "behandling,status,endret_av\n101,OK,Z990123\n102,OK,Z990124\n";
    const abs = skriv("r/Q-1.csv", kilde);
    const v = vurderFil(abs, "r/Q-1.csv", false, undefined, true);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "endret_av", rader: 2 }]);
    expect(Buffer.from(v.bytes!).toString("utf8")).toBe("behandling,status\n101,OK\n102,OK\n");
    expect(readFileSync(abs, "utf8")).toBe(kilde);
  });

  test("CSV: et fødselsnummer avvises, også når en annen kolonne fjernes", () => {
    const abs = skriv("r/fnr.csv", `fnr,endret_av\n${FNR},Z990123\n`);
    const v = vurderFil(abs, "r/fnr.csv", false, undefined, true);
    expect(v.fjernet).toEqual([{ navn: "endret_av", rader: 1 }]);
    expect(v.avslag).toEqual([`r/fnr.csv:2: fødselsnummer *********${FNR.slice(-2)} (i kopien etter at kolonnene er fjernet)`]);
  });

  test("CSV: et fødselsnummer som bare oppstår i kopien når kolonnen mellom er borte, avvises ved ny skanning", () => {
    const abs = skriv("r/sammen.csv", `a,b,c\n${FNR.slice(0, 6)},Z990123,${FNR.slice(6)}\n`);
    const v = vurderFil(abs, "r/sammen.csv", false, undefined, true);
    expect(v.fjernet).toEqual([{ navn: "b", rader: 1 }]);
    expect(v.avslag.join("\n")).toContain("fødselsnummer");
  });

  test("CSV: en e-postadresse avvises, kolonnen fjernes ikke", () => {
    const abs = skriv("r/epost.csv", "a,b\n1,ola@example.no\n");
    const v = vurderFil(abs, "r/epost.csv", true, undefined, true);
    expect(v.fjernet).toEqual([]);
    expect(v.avslag).toHaveLength(1);
    expect(v.avslag[0]).toContain("e-post");
  });

  test("YAML: en NAVident avvises, også med --tillat-ident, og uten å foreslå flagget", () => {
    const abs = skriv("r/cases.yaml", "- id: MELOSYS-1\n  eier: Z990123\n");
    const v = vurderFil(abs, "r/cases.yaml", true, undefined, true);
    expect(v.fjernet).toEqual([]);
    expect(v.avslag).toEqual(["r/cases.yaml:2: NAVident *****23"]);
    expect(v.advarsler).toEqual([]);
  });

  test("en NAVident i filnavnet avvises også med --tillat-ident", () => {
    const abs = skriv("r/Z990123.csv", "a\n1\n");
    const v = vurderFil(abs, "r/Z990123.csv", true, undefined, true);
    expect(v.avslag.join("\n")).toContain("filnavnet har NAVident");
    expect(v.advarsler).toEqual([]);
  });

  test("SQL: en NAVident avvises", () => {
    const abs = skriv("r/Q-1.sql", "select * from behandling where endret_av = 'Z990123';\n");
    expect(vurderFil(abs, "r/Q-1.sql", false, undefined, true).avslag).toHaveLength(1);
  });

  test("en datafil over 1 MB avvises; en side på samme størrelse godtas", () => {
    const stor = "a".repeat(1024 * 1024 + 1);
    expect(vurderFil(skriv("r/stor.csv", stor), "r/stor.csv", false, undefined, true).avslag.join("\n")).toMatch(/større enn 1048576 byte/);
    expect(vurderFil(skriv("r/stor.md", stor), "r/stor.md", false).avslag).toEqual([]);
  });
});
