// csvSifferTekst: hvilke celler som stopper sammenslåingen av sifre i en
// CSV-datafil, og at regelen ikke gir flere funn enn skanningen på main
// (skannTekst på hele filen). Alle numre er syntetiske.
import { describe, expect, test } from "bun:test";
import { csvSifferTekst, skannCsv, skannTekst } from "./publiser-felles-wiki.ts";

describe("csvSifferTekst", () => {
  test("ISO-dato og tidsstempel blir x", () => {
    for (const d of ["2023-02-09", "2023-02-09 10:15", "2023-02-09T10:15:30", "2023-02-09 10:15:30.123456", "2023-02-09T10:15:30Z", "2023-02-09T10:15:30.5+01:00", "2023-02-09 10:15:30-02:00", "2023-02-09 10:15:30+01"]) {
      expect(csvSifferTekst(`a,b\n${d},1\n`)).toBe("a,b\nx,1\n");
      expect(csvSifferTekst(`a,b\n"${d}",1\n`)).toBe("a,b\nx,1\n");
    }
  });

  test("ikke en ISO-dato: skannes som den er", () => {
    for (const d of ["2023-13-09", "2023-02-32", "2023-02-09 24:00", "2023-02-09 10", "2023-02-09X", "20230209", "09.02.2023", "2023-2-9"]) {
      expect(csvSifferTekst(`a,b\n${d},1\n`)).toBe(`a,b\n${d},1\n`);
    }
  });

  test("desimaltall med brøkdel blir x; med bare nuller i brøkdelen skannes det som det er", () => {
    expect(csvSifferTekst("a,b,c,d\n1.2,-3.5,+0.25,1\n")).toBe("a,b,c,d\nx,x,x,1\n");
    expect(csvSifferTekst('a,b\n"1,2",1\n')).toBe("a,b\nx,1\n");
    expect(csvSifferTekst("a,b,c\n12345.0,345.00,-7.000\n")).toBe("a,b,c\n12345.0,345.00,-7.000\n");
    expect(csvSifferTekst('a,b\n"12345,00",1\n')).toBe('a,b\n"12345,00",1\n');
  });

  test("overskrift delt med semikolon eller tabulator: uendret, også poster med komma", () => {
    for (const t of ["a;b\nx;1,1.2,2023-02-09\n", "a\tb\nx\t1,1.2,2023-02-09\n", "\na;b\n1,1.2\n"]) {
      expect(csvSifferTekst(t)).toBe(t);
    }
  });

  test("desimaltall med 11 sifre eller flere skannes som det er", () => {
    expect(csvSifferTekst("a,b\n150385.12345,1\n")).toBe("a,b\n150385.12345,1\n");
  });

  test("tomme celler, tekst og heltall er uendret", () => {
    const t = "a,b,c,d,e\nx,,-, 12 ,'7\n";
    expect(csvSifferTekst(t)).toBe(t);
  });

  test("en post med én celle er uendret (semikolon- eller tabulatordelt, alene CR)", () => {
    expect(csvSifferTekst("a;b\n1.2;2023-02-09\n2023-02-09\n")).toBe("a;b\n1.2;2023-02-09\n2023-02-09\n");
    expect(csvSifferTekst("a\r1.2\r2023-02-09\n")).toBe("a\r1.2\r2023-02-09\n");
  });

  test("en celle over flere linjer er uendret", () => {
    expect(csvSifferTekst('a,b\n"1.2\n",1\n')).toBe('a,b\n"1.2\n",1\n');
  });

  test("CRLF beholdes, og linjene er de samme", () => {
    expect(csvSifferTekst("a,b\r\n1.2,2023-02-09\r\nx,1\r\n")).toBe("a,b\r\nx,x\r\nx,1\r\n");
  });

  test("null når filen ikke kan leses som CSV", () => {
    expect(csvSifferTekst('a,b\n"x"y,1\n')).toBeNull();
  });
});

describe("rate av fødselsnummerfunn i tilfeldige datarader", () => {
  // Fast frø, så testen er deterministisk.
  function tilfeldig(frø: number) {
    let a = frø;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r = tilfeldig(20261014);
  const tall = (min: number, maks: number, bredde: number) => String(min + Math.floor(r() * (maks - min + 1))).padStart(bredde, "0");
  const dag = () => tall(1, 28, 2);
  const mnd = () => tall(1, 12, 2);
  const fem = () => tall(10000, 99999, 5);
  const N = 20_000;
  // `lik`: ingen celle i formen stopper sammenslåingen, så funnene er de samme
  // som på main. `null`: main finner bare nummer som går over cellen som
  // stopper sammenslåingen, så her finnes ingen; at main finner noen, viser
  // at regelen virker.
  const former: [string, "lik" | "null", () => string][] = [
    ["DD.MM.20YY,<5>", "lik", () => `${dag()}.${mnd()}.20${tall(0, 30, 2)},${fem()}`],
    ["YYYY-MM-DD,<5>", "lik", () => `20${tall(0, 30, 2)}-${mnd()}-${dag()},${fem()}`],
    ["YYYY-MM-DD HH:MM:SS,<1>,<1>", "null", () => `20${tall(0, 30, 2)}-${mnd()}-${dag()} ${tall(0, 23, 2)}:${tall(0, 59, 2)}:${tall(0, 59, 2)},${tall(0, 9, 1)},${tall(0, 9, 1)}`],
    ["<6>,<2>,<2>,<1.1>", "null", () => `${tall(0, 999999, 6)},${tall(0, 99, 2)},${tall(0, 99, 2)},${tall(0, 9, 1)}.${tall(1, 9, 1)}`],
  ];
  for (const [navn, forventet, rad] of former) {
    test(`${navn}: ${forventet === "lik" ? "samme funn som på main" : "ingen funn, main har noen"}`, () => {
      let main = 0;
      let nå = 0;
      for (let i = 0; i < N; i++) {
        const csv = `a,b,c,d\n${rad()}\n`;
        if (skannTekst(csv).some((f) => f.type !== "organisasjonsnummer")) main++;
        if (skannCsv(csv).some((f) => f.type !== "organisasjonsnummer")) nå++;
      }
      if (forventet === "lik") expect(nå).toBe(main);
      else {
        expect(main).toBeGreaterThan(0);
        expect(nå).toBe(0);
      }
    });
  }

});
