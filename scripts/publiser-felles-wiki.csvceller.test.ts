// En CSV-datafil: sifre slås sammen på tvers av celler som på main, unntatt
// over desimaltall og ISO-datoer. Testene går gjennom vurderFil alene, så de
// kan kjøres mot origin/main og vise hvilke som var røde der. Alle numre er
// syntetiske, bygget fra kontrollsifferalgoritmen.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { klassifiser11, vurderFil } from "./publiser-felles-wiki.ts";

function mod11(d: number[], w: number[]): number | null {
  const k = 11 - (w.reduce((a, x, i) => a + x * d[i]!, 0) % 11);
  return k === 11 ? 0 : k === 10 ? null : k;
}

/** Første gyldige nummer med datodelen `ddmmyy` der `ok` godtar de fem siste sifrene. */
function lagNummer(ddmmyy: string, ok: (fem: string) => boolean = () => true, start = 500): string {
  for (let i = 0; i < 1000; i++) {
    const ni = ddmmyy + String((start + i) % 1000).padStart(3, "0");
    const d = [...ni].map(Number);
    const k1 = mod11(d, [3, 7, 6, 1, 8, 9, 4, 5, 2]);
    if (k1 === null) continue;
    const k2 = mod11([...d, k1], [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    if (k2 === null) continue;
    const nr = ni + k1 + k2;
    if (ok(nr.slice(6))) return nr;
  }
  throw new Error("fant ikke et gyldig nummer");
}

const FNR = lagNummer("150385");
const DATO = FNR.slice(0, 6);
const PERS = FNR.slice(6);
const DNR = lagNummer("550385");
const HNR = lagNummer("154385");
const IDENT = "Z010126";

const rot = mkdtempSync(path.join(tmpdir(), "felles-csv-celler-"));
afterAll(() => rmSync(rot, { recursive: true, force: true }));
let n = 0;
function vurder(innhold: string, tillatIdent = false, endelse = ".csv", datafil = true) {
  const rel = `r/f${++n}${endelse}`;
  mkdirSync(path.join(rot, "r"), { recursive: true });
  writeFileSync(path.join(rot, rel), innhold);
  return { rel, v: vurderFil(path.join(rot, rel), rel, tillatIdent, undefined, datafil) };
}
const fnrFunn = (avslag: string[]) => avslag.filter((a) => /fødselsnummer|D-nummer|H-nummer/.test(a));

describe("forutsetninger", () => {
  test("sifrene på tvers av cellene i Q-G-raden består dato- og mod11-sjekken", () => {
    expect(klassifiser11(IDENT.slice(1) + "30251")).toBe("fødselsnummer");
  });
  test("de syntetiske D- og H-numrene klassifiseres som det de heter", () => {
    expect(klassifiser11(DNR)).toBe("D-nummer");
    expect(klassifiser11(HNR)).toBe("H-nummer");
  });
});

describe("falske funn som forsvinner (røde på origin/main)", () => {
  const QG = `ENDRET_AV,ANTALL,DAGER,SNITT_PER_DAG,FOERSTE,SISTE\n${IDENT},30,25,1.2,2023-02-09,2023-11-27\n`;

  test("Q-G-raden avvises ikke; identkolonnen fjernes som før", () => {
    const { v } = vurder(QG);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "ENDRET_AV", rader: 1 }]);
  });

  test("desimalkomma i en celle i anførselstegn stopper sammenslåingen", () => {
    expect(vurder(`a,b,c,d\n${IDENT},30,25,"1,2"\n`).v.avslag).toEqual([]);
  });

  test("et negativt desimaltall stopper sammenslåingen", () => {
    expect(vurder(`a,b,c,d,e\nx,${IDENT.slice(1)},30,25,-1.5\n`).v.avslag).toEqual([]);
  });

  // Formen fra vedtaksdato.csv linje 8: tekstceller, fem tomme celler, et
  // tidsstempel og to små tall. MMDD HH:MM:SS + første tall gir 11 sifre.
  const TS = lagNummer("050310", (p) => Number(p.slice(0, 2)) < 60 && Number(p.slice(2, 4)) < 60, 0);
  const VEDTAK = `a,b,c,d,e,f,g,h,i,j,k,l,m\nMEL-123456,123456,NY_VURDERING,AVSLUTTET,MEDLEM_I_FOLKETRYGDEN,*** MANGLER ***,,,,,2024-${TS.slice(0, 2)}-${TS.slice(2, 4)} ${TS.slice(4, 6)}:${TS.slice(6, 8)}:${TS.slice(8, 10)},${TS.slice(10)},1\n`;

  test("forutsetning: tidsstempelet og tallet etter gir et gyldig nummer", () => {
    expect(klassifiser11(TS)).toBe("fødselsnummer");
  });

  test("vedtaksdato-formen avvises ikke", () => {
    expect(vurder(VEDTAK).v.avslag).toEqual([]);
  });
});

describe("--tillat-ident gjelder datafiler (røde på origin/main)", () => {
  test("NAVident-kolonnen beholdes, og byteene som lastes opp, er kildefilens", () => {
    const kilde = "behandling,endret_av\n101,Z990123\n";
    const { rel, v } = vurder(kilde, true);
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([]);
    expect(Buffer.from(v.bytes!).toString("utf8")).toBe(kilde);
    expect(v.advarsler).toEqual([`${rel}:2: NAVident *****23 (tillatt med --tillat-ident)`]);
  });

  test("en e-post i en datafil er en advarsel med flagget; et fødselsnummer avvises fortsatt", () => {
    const e = vurder("a,b\n1,ola@example.no\n", true);
    expect(e.v.avslag).toEqual([]);
    expect(e.v.advarsler).toEqual([`${e.rel}:2: e-post ************no (tillatt med --tillat-ident)`]);
    const f = vurder(`a,b\n1,${FNR}\n2,Z990123\n`, true);
    expect(f.v.avslag).toEqual([`${f.rel}:2: fødselsnummer *********${FNR.slice(-2)}`]);
  });
});

describe("paritet: avvises som på origin/main", () => {
  const P = FNR.slice(-2);
  const former: [string, string][] = [
    ["DDMMYY,5", `a,b\n${DATO},${PERS}\n`],
    ["DD.MM.YY,5", `a,b\n${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)},${PERS}\n`],
    ["DD/MM/YY,5", `a,b\n${DATO.slice(0, 2)}/${DATO.slice(2, 4)}/${DATO.slice(4)},${PERS}\n`],
    ["DD MM YY,5", `a,b\n${DATO.slice(0, 2)} ${DATO.slice(2, 4)} ${DATO.slice(4)},${PERS}\n`],
    ["DD,MM,YY,5", `a,b,c,d\n${DATO.slice(0, 2)},${DATO.slice(2, 4)},${DATO.slice(4)},${PERS}\n`],
    ["dato,-,5", `a,b,c\n${DATO},-,${PERS}\n`],
    ["dato,,5", `a,b,c\n${DATO},,${PERS}\n`],
    ["dato,'5", `a,b\n${DATO},'${PERS}\n`],
    ["dato,5.0", `a,b\n${DATO},${PERS}.0\n`],
    ["dato,\"5,00\"", `a,b\n${DATO},"${PERS},00"\n`],
    ["2,3,3,3", `a,b,c,d\n${FNR.slice(0, 2)},${FNR.slice(2, 5)},${FNR.slice(5, 8)},${FNR.slice(8)}\n`],
    ["2,3,3,3.00", `a,b,c,d\n${FNR.slice(0, 2)},${FNR.slice(2, 5)},${FNR.slice(5, 8)},${FNR.slice(8)}.00\n`],
    ["én celle", `a,b,c\n1,${FNR},2\n`],
    ["én celle med mellomrom", `a,b,c\n1,${DATO} ${PERS},2\n`],
    ["én celle med punktum", `a,b,c\n1,${DATO}.${PERS},2\n`],
    ["én celle med datopunktum", `a,b,c\n1,${DATO.slice(0, 2)}.${DATO.slice(2, 4)}.${DATO.slice(4)} ${PERS},2\n`],
    ["én celle i anførselstegn", `a,b,c\n1,"nr, ${DATO} ${PERS}",2\n`],
  ];
  for (const [navn, csv] of former) {
    test(`${navn}: fødselsnummer`, () => {
      const { rel, v } = vurder(csv);
      expect(fnrFunn(v.avslag)).toEqual([`${rel}:2: fødselsnummer *********${P}`]);
    });
  }

  test("alene CR: postene står på én linje for skanneren", () => {
    const { rel, v } = vurder(`a,b\rx,${DATO}\r${PERS},y\n`);
    expect(fnrFunn(v.avslag)).toEqual([`${rel}:1: fødselsnummer *********${P}`]);
  });

  test("D-nummer og H-nummer delt over to celler", () => {
    const d = vurder(`a,b\n${DNR.slice(0, 6)},${DNR.slice(6)}\n`);
    expect(d.v.avslag).toEqual([`${d.rel}:2: D-nummer *********${DNR.slice(-2)}`]);
    const h = vurder(`a,b\n${HNR.slice(0, 6)},${HNR.slice(6)}\n`);
    expect(h.v.avslag).toEqual([`${h.rel}:2: H-nummer *********${HNR.slice(-2)}`]);
  });

  test("linjenummeret stemmer når et felt i anførselstegn går over flere linjer", () => {
    const { rel, v } = vurder(`id,notat\n1,"første linje\nandre ${DATO}","${PERS}"\n2,x\n`);
    expect(v.avslag).toEqual([`${rel}:3: fødselsnummer *********${P}`]);
  });

  test("HTML-celler på hver sin linje i et felt i anførselstegn", () => {
    const { rel, v } = vurder(`a,b\n1,"x\n<td>${DATO}</td>\n<td>${PERS}</td>\ny"\n`);
    expect(v.avslag).toEqual([`${rel}:3: fødselsnummer *********${P}`]);
  });

  test("en semikolondelt CSV skannes som før, også med desimalkomma", () => {
    const { rel, v } = vurder(`a;b;c\n${IDENT.slice(1)};30;25,1\n`);
    expect(v.avslag).toEqual([`${rel}:2: fødselsnummer *********51`]);
  });

  test("uten --tillat-ident fjernes en kolonne med bare NAVident", () => {
    const { v } = vurder("behandling,endret_av\n101,Z990123\n");
    expect(v.avslag).toEqual([]);
    expect(v.fjernet).toEqual([{ navn: "endret_av", rader: 1 }]);
    expect(Buffer.from(v.bytes!).toString("utf8")).toBe("behandling\n101\n");
  });

  test("Q-G-raden avvises fortsatt i en side, en .sql og en .yaml", () => {
    const rad = `${IDENT},30,25,1.2,2023-02-09,2023-11-27\n`;
    for (const [endelse, datafil] of [[".md", false], [".sql", true], [".yaml", true]] as const) {
      const { rel, v } = vurder(rad, true, endelse, datafil);
      expect(fnrFunn(v.avslag)).toEqual([`${rel}:1: fødselsnummer *********51`]);
    }
  });

  test("en CSV som ikke kan leses, skannes som før", () => {
    const { rel, v } = vurder(`a,b\n${IDENT},30,25,1.2,"x"y\n`);
    expect(fnrFunn(v.avslag)).toEqual([`${rel}:2: fødselsnummer *********51`]);
  });
});
