// Datafilene en side viser: porten av muninns regel, kolonnene med NAVident
// som fjernes fra en CSV-kopi, og vurderingen av datafiler. Alle verdier er
// syntetiske.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fjernIdentKolonner, klassifiser11, navngitteDatafiler, vurderFil } from "./publiser-felles-wiki.ts";
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

describe("navngitteDatafiler finner også det muninn ikke leser", () => {
  // Å finne for mye er trygt: filen skannes likevel. Å finne for lite gir «File not available» i poden.
  const refs = (md: string) => navngitteDatafiler("plans/side.mdx", md).map((d) => d.ref);
  test("en komponent fire nivåer ned", () => {
    const md = '<Callout>\n<Fold title="a">\n<Callout>\n<Fold title="b">\n<Query id="q" csv="dyp.csv" />\n</Fold>\n</Callout>\n</Fold>\n</Callout>\n';
    expect(refs(md)).toEqual(["dyp.csv"]);
  });
  test("en ukjent beholder, enkle anførselstegn på beholderen, og en lukking som krysser beholderen", () => {
    expect(refs('<Ukjent><Query id="q" csv="a.csv" /></Ukjent>\n')).toEqual(["a.csv"]);
    expect(refs("<Callout tone='info'><Query id=\"q\" csv=\"b.csv\" /></Callout>\n")).toEqual(["b.csv"]);
    expect(refs('<Callout><Query id="q" csv="c.csv" />\n</Callout>\n')).toEqual(["c.csv"]);
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

  test("en NAVident i fritekst fjerner hele kolonnen; flere kolonner og fil uten avsluttende linjeskift", () => {
    const csv = "a,b,c,d\nZ990123,x,endret av Z990124 i går,y";
    expect(fjernIdentKolonner(csv)).toEqual({
      tekst: "b,d\nx,y",
      fjernet: [{ navn: "a", rader: 1 }, { navn: "c", rader: 1 }],
    });
  });

  test("en overskrift som selv er en NAVident, vises som kolonnenummer", () => {
    const r = fjernIdentKolonner("id,Z990123\n1,2\n");
    expect(r).toEqual({ tekst: "id\n1\n", fjernet: [{ navn: "kolonne nr. 2", rader: 1 }] });
  });

  test("hver post beholder sitt eget linjeskift", () => {
    expect(fjernIdentKolonner("a,b\r\n1,Z990123\n2,Z990124\r\n")).toEqual({
      tekst: "a\r\n1\n2\r\n",
      fjernet: [{ navn: "b", rader: 2 }],
    });
  });

  test("en CSV der alle kolonnene ville blitt fjernet, gir en grunn", () => {
    const r = fjernIdentKolonner("endret_av,Z990124\nZ990123,Z990125\n");
    expect(typeof r).toBe("string");
    expect(r as string).toContain("ingen kolonner igjen");
  });

  test("en semikolon- eller tabulatordelt CSV med desimalkomma avvises og nevner skilletegnet", () => {
    // Før: kommaene i 12,5 og 7,25 ga to kolonner, kolonne 1 (hele «1;Z990123;12») ble fjernet, og «5» og «25» ble lastet opp.
    const semikolon = fjernIdentKolonner("id;endret_av;belop\n1;Z990123;12,5\n2;Z990124;7,25\n");
    expect(typeof semikolon).toBe("string");
    expect(semikolon as string).toContain("semikolon");
    const tab = fjernIdentKolonner("id\tendret_av\tbelop\n1\tZ990123\t12,5\n");
    expect(typeof tab).toBe("string");
    expect(tab as string).toContain("tabulator");
  });

  test("et semikolon i en overskrift i anførselstegn er ikke et skilletegn", () => {
    expect(fjernIdentKolonner('"id;nr",endret_av\n1,Z990123\n')).toEqual({ tekst: '"id;nr"\n1\n', fjernet: [{ navn: "endret_av", rader: 1 }] });
  });

  // Klassesjekk: kolonner fjernes bare fra kommadelt, rektangulær CSV. Hver
  // form under ga før en kopi med rester av tallene («5», «"5"""»).
  const avvist = (csv: string, grunn: string) => {
    const r = fjernIdentKolonner(csv);
    expect(typeof r === "string" ? r : `lastet opp: ${JSON.stringify(r.tekst)}`).toContain(grunn);
  };

  test("tekst etter et avsluttende anførselstegn avvises (alle celler i anførselstegn, semikolondelt)", () => {
    avvist('"id";"endret_av";"belop"\n"1";"Z990123";"12,5"\n', "etter et avsluttende anførselstegn");
  });

  test("tekst etter et avsluttende anførselstegn avvises (bare første celle i anførselstegn)", () => {
    avvist('"id";endret_av;belop\n1;Z990123;12,5\n', "etter et avsluttende anførselstegn");
  });

  test("tekst etter et avsluttende anførselstegn i en datarad avvises", () => {
    avvist('a,b\n"x"y,Z990123\n', "etter et avsluttende anførselstegn");
  });

  test("en overskrift med bare én kolonne avvises", () => {
    avvist('"id;endret_av;belop"\n1;Z990123;12,5\n', "færre enn to kolonner");
    avvist("rapport\n1;Z990123;12,5\n", "færre enn to kolonner");
    avvist("   \nid;endret_av;belop\n1;Z990123;12,5\n", "færre enn to kolonner");
    avvist("id|endret_av|belop\n1|Z990123|12,5\n", "færre enn to kolonner");
  });

  test("en post med et annet antall kolonner enn overskriften avvises", () => {
    avvist("id,endret_av\n1,Z990123,x\n", "rad 2 har 3 kolonner");
    avvist("id,endret_av,belop\n1,Z990123\n", "rad 2 har 2 kolonner");
  });

  test("et semikolon i en overskriftscelle uten anførselstegn avvises også når overskriften har komma", () => {
    avvist("id;nr,endret_av\n1;2,Z990123\n", "semikolon");
  });

  test("overskriften er første post som ikke er tom; tomme linjer før og mellom postene beholdes", () => {
    expect(fjernIdentKolonner("\n\nid,endret_av\n1,Z990123\n\n2,Z990124\n")).toEqual({
      tekst: "\n\nid\n1\n\n2\n",
      fjernet: [{ navn: "endret_av", rader: 2 }],
    });
  });

  test("et semikolon eller en tabulator i en datarad i en kommadelt CSV avvises ikke", () => {
    expect(fjernIdentKolonner("id,notat,endret_av\n1,a;b,Z990123\n2,x\ty,Z990124\n")).toEqual({
      tekst: "id,notat\n1,a;b\n2,x\ty\n",
      fjernet: [{ navn: "endret_av", rader: 2 }],
    });
  });

  test("en fil med 700 000 poster, de fleste tomme linjer, gir en kopi i stedet for å krasje", () => {
    // Før: Math.max(...poster) sprengte kallstakken over omtrent 637 000 poster.
    const start = "a,b\n1,Z990123\n";
    const tomme = "\n".repeat(700_000);
    const r = fjernIdentKolonner(start + tomme);
    expect(r).toEqual({ tekst: "a\n1\n" + tomme, fjernet: [{ navn: "b", rader: 1 }] });
  }, 10_000);

  test("en overskrift med kontrolltegn skrives ut med tegnene synlige", () => {
    const r = fjernIdentKolonner("id,\u001b[31mendret\n1,Z990123\n");
    expect(r).toEqual({ tekst: "id\n1\n", fjernet: [{ navn: "\\u{1b}[31mendret", rader: 1 }] });
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

  test("CSV: et fødselsnummer i kildefilen avvises før noen kolonne fjernes", () => {
    const abs = skriv("r/fnr.csv", `fnr,endret_av\n${FNR},Z990123\n`);
    const v = vurderFil(abs, "r/fnr.csv", false, undefined, true);
    expect(v.fjernet).toEqual([]);
    expect(v.avslag.join("\n")).toContain(`r/fnr.csv:2: fødselsnummer *********${FNR.slice(-2)}`);
  });

  test("CSV: et fødselsnummer i samme kolonne som en NAVident avvises, selv om kolonnen ville blitt fjernet", () => {
    const abs = skriv("r/samme.csv", `id,notat\n1,Z990123\n2,${FNR}\n`);
    const v = vurderFil(abs, "r/samme.csv", false, undefined, true);
    expect(v.fjernet).toEqual([]);
    expect(v.avslag.join("\n")).toContain("fødselsnummer");
  });

  test("CSV: en kopi som blir større enn 1 MB etter at kolonnen er fjernet, avvises", () => {
    // Et anførselstegn midt i et felt uten anførselstegn skrives tilbake sitert og doblet.
    const rad = `q${'"'.repeat(500)},Z990123\n`;
    const kilde = "a,b\n" + rad.repeat(Math.floor((1024 * 1024 - 4) / rad.length));
    expect(Buffer.byteLength(kilde)).toBeLessThanOrEqual(1024 * 1024);
    const v = vurderFil(skriv("r/vokser.csv", kilde), "r/vokser.csv", false, undefined, true);
    expect(v.bytes).toBeUndefined();
    expect(v.avslag.join("\n")).toMatch(/kopien er større enn 1048576 byte/);
  });

  test("CSV: en semikolondelt fil med NAVident avvises i stedet for å lastes opp tom", () => {
    const v = vurderFil(skriv("r/semikolon.csv", "id;endret_av\n1;Z990123\n"), "r/semikolon.csv", false, undefined, true);
    expect(v.bytes).toBeUndefined();
    expect(v.avslag.join("\n")).toContain("delt med semikolon");
  });

  test("CSV: en semikolondelt fil med desimalkomma og NAVident avvises og lastes ikke opp", () => {
    const v = vurderFil(skriv("r/desimal.csv", "id;endret_av;belop\n1;Z990123;12,5\n2;Z990124;7,25\n"), "r/desimal.csv", false, undefined, true);
    expect(v.bytes).toBeUndefined();
    expect(v.avslag.join("\n")).toContain("semikolon");
  });

  test("CSV: en fil med 700 000 poster, de fleste tomme linjer, vurderes uten å krasje", () => {
    const start = "a,b\n1,Z990123\n";
    const v = vurderFil(skriv("r/tomme.csv", start + "\n".repeat(700_000)), "r/tomme.csv", false, undefined, true);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "b", rader: 1 }]);
  }, 10_000);

  // Fødselsdato og personnummer i nabokolonner etter at identkolonnen mellom er fjernet: regelen for dato + 5 sifre.
  test("CSV: et fødselsnummer som bare oppstår i kopien når kolonnen mellom er borte, avvises ved ny skanning", () => {
    const abs = skriv("r/sammen.csv", `a,b,c\n${FNR.slice(0, 6)},Z990123,${FNR.slice(6)}\n`);
    const v = vurderFil(abs, "r/sammen.csv", false, undefined, true);
    expect(v.fjernet).toEqual([{ navn: "b", rader: 1 }]);
    expect(v.avslag).toEqual([`r/sammen.csv:2: fødselsnummer *********${FNR.slice(-2)} (i kopien etter at kolonnene er fjernet)`]);
  });

  test("CSV: en e-postadresse avvises, kolonnen fjernes ikke", () => {
    const abs = skriv("r/epost.csv", "a,b\n1,ola@example.no\n");
    const v = vurderFil(abs, "r/epost.csv", false, undefined, true);
    expect(v.fjernet).toEqual([]);
    expect(v.avslag).toHaveLength(1);
    expect(v.avslag[0]).toContain("e-post");
  });

  // Endret 2026-10-13: --tillat-ident gjelder også datafiler.
  test("YAML: en NAVident avvises uten --tillat-ident og er en advarsel med", () => {
    const abs = skriv("r/cases.yaml", "- id: MELOSYS-1\n  eier: Z990123\n");
    const uten = vurderFil(abs, "r/cases.yaml", false, undefined, true);
    expect(uten.fjernet).toEqual([]);
    expect(uten.avslag).toEqual(["r/cases.yaml:2: NAVident *****23 (bruk --tillat-ident hvis dette er med vilje)"]);
    const med = vurderFil(abs, "r/cases.yaml", true, undefined, true);
    expect(med.avslag).toEqual([]);
    expect(med.advarsler).toEqual(["r/cases.yaml:2: NAVident *****23 (tillatt med --tillat-ident)"]);
  });

  test("en NAVident i filnavnet avvises uten --tillat-ident og er en advarsel med", () => {
    const abs = skriv("r/Z990123.csv", "a\n1\n");
    expect(vurderFil(abs, "r/Z990123.csv", false, undefined, true).avslag.join("\n")).toContain("filnavnet har NAVident");
    const med = vurderFil(abs, "r/Z990123.csv", true, undefined, true);
    expect(med.avslag).toEqual([]);
    expect(med.advarsler).toEqual(["filnavnet har NAVident *****23 (tillatt med --tillat-ident)"]);
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

describe("en CSV-datafil skannes for fødselsnummer celle for celle", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-csv-celler-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const vurder = (rel: string, innhold: string, tillatIdent = false) => {
    mkdirSync(path.dirname(path.join(rot, rel)), { recursive: true });
    writeFileSync(path.join(rot, rel), innhold);
    return vurderFil(path.join(rot, rel), rel, tillatIdent, undefined, true);
  };
  const DATO = FNR.slice(0, 6);
  const PERS = FNR.slice(6);
  // Formen fra kode-wikiens Q-G.csv: identens sifre + ANTALL + DAGER + første siffer i SNITT gir 11 sifre.
  const IDENT = "Z010126";
  const QG = `ENDRET_AV,ANTALL,DAGER,SNITT_PER_DAG,FOERSTE,SISTE\n${IDENT},30,25,1.2,2023-02-09,2023-11-27\n`;

  test("forutsetning: sifrene på tvers av cellene i Q-G-raden består dato- og mod11-sjekken", () => {
    expect(klassifiser11(IDENT.slice(1) + "30251")).toBe("fødselsnummer");
  });

  test("(a) Q-G-raden avvises ikke som fødselsnummer; identkolonnen fjernes som før", () => {
    const v = vurder("r/Q-G.csv", QG);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "ENDRET_AV", rader: 1 }]);
  });

  test("(b) et fødselsnummer i én celle avvises fortsatt, også delt opp inne i cellen", () => {
    for (const celle of [FNR, `${DATO} ${PERS}`, `${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)}-${PERS}`, `"nr, ${DATO} ${PERS}"`]) {
      const v = vurder("r/en-celle.csv", `id,notat,n\n1,${celle},2\n`);
      expect(v.avslag).toEqual([`r/en-celle.csv:2: fødselsnummer *********${FNR.slice(-2)}`]);
    }
  });

  test("(b) linjenummeret stemmer når et felt i anførselstegn går over flere linjer", () => {
    const v = vurder("r/flerlinje.csv", `id,notat\n1,"første linje\nandre ${FNR}"\n2,x\n`);
    expect(v.avslag).toEqual([`r/flerlinje.csv:3: fødselsnummer *********${FNR.slice(-2)}`]);
  });

  test("(c) et nummer delt over to celler flagges ikke når den første cellen ikke er en fødselsdato", () => {
    const v = vurder("r/to-celler.csv", `a,b\n${FNR.slice(0, 4)},${FNR.slice(4)}\n`);
    expect(v.avslag).toEqual([]);
  });

  test("(c) heller ikke over to poster på samme linje (alene CR)", () => {
    expect(vurder("r/cr.csv", `a\r${DATO}\r${PERS}\n`).avslag).toEqual([]);
  });

  test("(c) heller ikke over to poster med én HTML-celle hver", () => {
    expect(vurder("r/td.csv", `a\n<td>${DATO}</td>\n<td>${PERS}</td>\n`).avslag).toEqual([]);
  });

  test("(b) HTML-celler på hver sin linje inne i samme felt i anførselstegn avvises fortsatt", () => {
    const v = vurder("r/td-felt.csv", `a,b\n1,"x\n<td>${DATO}</td>\n<td>${PERS}</td>\ny"\n`);
    expect(v.avslag).toEqual([`r/td-felt.csv:3: fødselsnummer *********${FNR.slice(-2)}`]);
  });

  test("(d) med --tillat-ident beholdes NAVident-kolonnen, og byteene som lastes opp, er kildefilens", () => {
    const kilde = "behandling,endret_av\n101,Z990123\n";
    const v = vurder("r/ident.csv", kilde, true);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([]);
    expect(Buffer.from(v.bytes!).toString("utf8")).toBe(kilde);
    expect(v.advarsler).toEqual(["r/ident.csv:2: NAVident *****23 (tillatt med --tillat-ident)"]);
  });

  test("(d) med --tillat-ident er en e-post i en datafil en advarsel; et fødselsnummer avvises fortsatt", () => {
    expect(vurder("r/epost-t.csv", "a,b\n1,ola@example.no\n", true).avslag).toEqual([]);
    const v = vurder("r/fnr-t.csv", `a,b\n1,${FNR}\n2,Z990123\n`, true);
    expect(v.avslag).toEqual([`r/fnr-t.csv:2: fødselsnummer *********${FNR.slice(-2)}`]);
  });

  test("(e) uten --tillat-ident fjernes NAVident-kolonnen som før", () => {
    const v = vurder("r/ident-u.csv", "behandling,endret_av\n101,Z990123\n");
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "endret_av", rader: 1 }]);
    expect(Buffer.from(v.bytes!).toString("utf8")).toBe("behandling\n101\n");
  });

  test("en side skannes som før: sifre i to kommadelte felt på samme linje flagges", () => {
    mkdirSync(rot, { recursive: true });
    writeFileSync(path.join(rot, "side.md"), `${DATO},${PERS}\n`);
    expect(vurderFil(path.join(rot, "side.md"), "side.md", false).avslag).toEqual([`side.md:1: fødselsnummer *********${FNR.slice(-2)}`]);
  });
});

describe("en CSV-datafil: fødselsdato og personnummer i hver sin celle", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-csv-dato-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const vurder = (rel: string, innhold: string, tillatIdent = false) => {
    mkdirSync(path.dirname(path.join(rot, rel)), { recursive: true });
    writeFileSync(path.join(rot, rel), innhold);
    return vurderFil(path.join(rot, rel), rel, tillatIdent, undefined, true);
  };
  const DATO = FNR.slice(0, 6);
  const PERS = FNR.slice(6);
  const PRIKK = `${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)}`;
  const avslag = (rel: string, type = "fødselsnummer", nr = FNR, linje = 2) => [`${rel}:${linje}: ${type} *********${nr.slice(-2)}`];

  test("forutsetning: de syntetiske D- og H-numrene klassifiseres som det de heter", () => {
    expect(klassifiser11(lagNummer("550385"))).toBe("D-nummer");
    expect(klassifiser11(lagNummer("154385"))).toBe("H-nummer");
  });

  test("6 sifre og så 5 sifre i neste celle avvises", () => {
    expect(vurder("r/d1.csv", `navn,fodselsdato,personnr\nOla,${DATO},${PERS}\n`).avslag).toEqual(avslag("r/d1.csv"));
  });

  test("DD.MM.YY og DD.MM.YYYY i datocellen avvises", () => {
    expect(vurder("r/d2.csv", `navn,fodselsdato,personnr\nOla,${PRIKK},${PERS}\n`).avslag).toEqual(avslag("r/d2.csv"));
    expect(vurder("r/d3.csv", `navn,fodselsdato,personnr\nOla,${PRIKK.slice(0, 6)}19${DATO.slice(4)},${PERS}\n`).avslag).toEqual(avslag("r/d3.csv"));
  });

  test("tomme celler mellom, blanke rundt og anførselstegn hindrer ikke sammenslåingen", () => {
    expect(vurder("r/d4.csv", `a,b,c,d\nOla,${DATO},,${PERS}\n`).avslag).toEqual(avslag("r/d4.csv"));
    expect(vurder("r/d5.csv", `a,b,c,d,e\nOla, ${DATO} ,, , ${PERS} \n`).avslag).toEqual(avslag("r/d5.csv"));
    expect(vurder("r/d6.csv", `a,b,c\n"Ola","${DATO}","${PERS}"\n`).avslag).toEqual(avslag("r/d6.csv"));
  });

  test("D-nummer og H-nummer delt på samme måte avvises", () => {
    const d = lagNummer("550385");
    const h = lagNummer("154385");
    expect(vurder("r/d7.csv", `a,b\n${d.slice(0, 6)},${d.slice(6)}\n`).avslag).toEqual(avslag("r/d7.csv", "D-nummer", d));
    expect(vurder("r/d8.csv", `a,b\n${h.slice(0, 6)},${h.slice(6)}\n`).avslag).toEqual(avslag("r/d8.csv", "H-nummer", h));
  });

  test("et fødselsnummer med tusenskilletegn uten anførselstegn avvises", () => {
    const v = vurder("r/d9.csv", `a,b,c,d\n${FNR.slice(0, 2)},${FNR.slice(2, 5)},${FNR.slice(5, 8)},${FNR.slice(8)}\n`);
    expect(v.avslag).toEqual(avslag("r/d9.csv"));
  });

  test("ikke sammenslått: annen celle mellom, feil antall sifre, eller over to poster", () => {
    expect(vurder("r/n1.csv", `a,b,c\n${DATO},x,${PERS}\n`).avslag).toEqual([]);
    expect(vurder("r/n2.csv", `a,b\n${DATO},${PERS}0\n`).avslag).toEqual([]);
    expect(vurder("r/n3.csv", `a,b\n0${DATO},${PERS}\n`).avslag).toEqual([]);
    expect(vurder("r/n4.csv", `a\n${DATO}\n${PERS}\n`).avslag).toEqual([]);
    expect(vurder("r/n5.csv", `a,b\n${PRIKK.replaceAll(".", "-")},${PERS}\n`).avslag).toEqual([]);
  });

  test("formen fra vedtaksdato.csv: 6 sifre, tomme celler og så et tidsstempel, flagges ikke", () => {
    expect(vurder("r/n6.csv", `a,b,c,d,e,f,g,h,i\nMEL-1,${DATO},NY,,,,,,2023-11-27 10:15:${PERS.slice(0, 2)}\n`).avslag).toEqual([]);
    expect(vurder("r/n7.csv", `a,b,c,d,e,f,g\n${DATO},,,,,,2023-11-27 10:15:00\n`).avslag).toEqual([]);
  });
});

describe("en CSV-celle leser ikke sifre fra nabocellen", () => {
  const rot = mkdtempSync(path.join(tmpdir(), "felles-csv-kant-"));
  afterAll(() => rmSync(rot, { recursive: true, force: true }));
  const vurder = (rel: string, innhold: string) => {
    writeFileSync(path.join(rot, rel), innhold);
    return vurderFil(path.join(rot, rel), rel, false, undefined, true);
  };
  // Hver rad gir et gyldig nummer bare når cellen tar med komma + 1 eller 2 tegn fra naboen.
  test("ingen sifre fra cellen etter (2 og 3 tegn over kommaet)", () => {
    expect(vurder("k1.csv", `a,b\n${FNR.slice(0, 10)},${FNR.slice(10)}\n`).avslag).toEqual([]);
    expect(vurder("k2.csv", `a,b\n${FNR.slice(0, 9)},${FNR.slice(9)}\n`).avslag).toEqual([]);
  });
  test("ingen sifre fra cellen før (2 og 3 tegn over kommaet)", () => {
    expect(vurder("k3.csv", `a,b\n${FNR.slice(0, 1)},${FNR.slice(1)}\n`).avslag).toEqual([]);
    expect(vurder("k4.csv", `a,b\n${FNR.slice(0, 2)},${FNR.slice(2)}\n`).avslag).toEqual([]);
  });
});
