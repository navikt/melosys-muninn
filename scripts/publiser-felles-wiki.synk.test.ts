// --status, --json og --synk mot en falsk `gcloud` først på PATH, som i
// publiser-felles-wiki.cli.test.ts. Listingen gir `md5_hash` og
// `noncurrent_time` bare når --format ber om feltene, så testene beviser at
// skriptet ber om dem. Ingen test her når Google.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SKRIPT = path.join(import.meta.dir, "publiser-felles-wiki.ts");

const LISTE_TS = `
import { existsSync, readFileSync } from "node:fs";
const [fil, url, format] = process.argv.slice(2);
const data = existsSync(fil) ? JSON.parse(readFileSync(fil, "utf8")) : [];
const rekursiv = url.endsWith("/**");
const ut = data
  .filter((x) => rekursiv || !x.name.includes("/"))
  .map((x) => {
    const y = { ...x };
    if (!/noncurrent_time/.test(format ?? "")) delete y.noncurrent_time;
    if (!/md5_hash/.test(format ?? "")) delete y.md5_hash;
    return y;
  });
console.log(JSON.stringify(ut));
`;

const FALSK_GCLOUD = `#!/bin/bash
d="$FAKE_GCLOUD_DIR"
n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/n"
printf '%s\\n' "$@" > "$d/kall-$n.args"
if [ "$1 $2 $3" = "storage objects list" ]; then
  if [ -f "$d/liste-feil" ]; then echo "falsk listefeil" >&2; exit 1; fi
  exec bun "$d/../liste.ts" "$d/liste.json" "$4" "$5"
fi
for a in "$@"; do if [ "$a" = "-" ]; then cat > "$d/kall-$n.stdin"; fi; done
exit 0
`;

let tmp: string;
let rot: string;
let falsk: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "felles-wiki-synk-"));
  rot = path.join(tmp, "wiki");
  falsk = path.join(tmp, "falsk");
  mkdirSync(rot);
  mkdirSync(path.join(tmp, "bin"));
  mkdirSync(falsk);
  writeFileSync(path.join(tmp, "bin", "gcloud"), FALSK_GCLOUD);
  writeFileSync(path.join(tmp, "liste.ts"), LISTE_TS);
  chmodSync(path.join(tmp, "bin", "gcloud"), 0o755);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Syntetisk, bygget fra kontrollsifferalgoritmen.
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

const md5 = (s: string | Uint8Array) => createHash("md5").update(s).digest("base64");

function skriv(rel: string, innhold: string): void {
  const abs = path.join(rot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, innhold);
}

/** Bøtta: navn → innholdet som ligger der (MD5 regnes ut), `null` for et objekt uten MD5. */
function bøtte(objekter: Record<string, string | null>, ekstra: object[] = []): void {
  const liste = Object.entries(objekter).map(([name, innhold]) => (innhold === null ? { name } : { name, md5_hash: md5(innhold) }));
  writeFileSync(path.join(falsk, "liste.json"), JSON.stringify([...liste, ...ekstra]));
}

function kjør(args: string[]) {
  const r = Bun.spawnSync(["bun", SKRIPT, ...args], {
    env: { ...process.env, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, FAKE_GCLOUD_DIR: falsk, FELLES_WIKI_BUCKET: "felles-test" },
  });
  return { kode: r.exitCode, stdout: r.stdout.toString(), ut: r.stdout.toString() + r.stderr.toString() };
}

function kall(): { args: string[]; stdin: string | null }[] {
  const n = existsSync(path.join(falsk, "n")) ? Number(readFileSync(path.join(falsk, "n"), "utf8")) : 0;
  const ut = [];
  for (let i = 1; i <= n; i++) {
    const s = path.join(falsk, `kall-${i}.stdin`);
    ut.push({ args: readFileSync(path.join(falsk, `kall-${i}.args`), "utf8").split("\n").slice(0, -1), stdin: existsSync(s) ? readFileSync(s, "utf8") : null });
  }
  return ut;
}
const destinasjoner = () => kall().filter((k) => k.args[1] === "cp").map((k) => k.args.at(-1));

interface SideJson {
  relPath: string;
  tilstand: string;
  endredeFiler: string[];
  avslag: string[];
  advarsler: string[];
}
function json(args: string[] = []): { kode: number; data: { bøtte: string; sider: SideJson[]; foreldreløse: string[] }; stdout: string } {
  const r = kjør(["--status", "--json", ...args, rot]);
  return { kode: r.kode, data: JSON.parse(r.stdout), stdout: r.stdout };
}
const side = (d: { sider: SideJson[] }, rel: string) => d.sider.find((s) => s.relPath === rel);

const SIDE = '# Rapport\n<Query id="Q-1" csv="rapport/Q-1.csv" />\n';
const CSV = "a,b\n1,2\n";
// En kolonne med NAVident: kopien som lastes opp, har bare kolonnene a og b.
const CSV_MED_IDENT = "a,b,endret_av\n1,2,Z990123\n";
const CSV_STRIPPET = "a,b\n1,2\n";

describe("--status", () => {
  test("uendret: siden og datafilen den viser, er lik bøtta; ingenting lastes opp", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", CSV);
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV });
    const r = kjør(["--status", rot]);
    expect(r.kode).toBe(0);
    expect(r.ut).toMatch(/UENDRET +plans\/r\.mdx/);
    expect(r.ut).toContain("1 uendret, 0 endret");
    expect(destinasjoner()).toEqual([]);
    expect(kall()[0]!.args).toContain("--format=json(name,md5_hash,noncurrent_time)");
    // En datafil en fulgt side viser, er ikke foreldreløs.
    expect(json().data.foreldreløse).toEqual([]);
  });

  test("endret side: siden er ulik bøtta og står i endredeFiler", () => {
    skriv("plans/r.mdx", SIDE + "ny linje\n");
    skriv("plans/rapport/Q-1.csv", CSV);
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV });
    const { kode, data } = json();
    expect(kode).toBe(0);
    expect(side(data, "plans/r.mdx")).toEqual({ relPath: "plans/r.mdx", tilstand: "endret", endredeFiler: ["plans/r.mdx"], avslag: [], advarsler: [] });
  });

  test("endret datafil: siden er lik, men CSV-en den viser, er ulik bøtta", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", "a,b\n1,3\n");
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV });
    const s = side(json().data, "plans/r.mdx")!;
    expect(s.tilstand).toBe("endret");
    expect(s.endredeFiler).toEqual(["plans/rapport/Q-1.csv"]);
  });

  test("en datafil som ikke er i bøtta ennå, gjør siden endret", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", CSV);
    bøtte({ "plans/r.mdx": SIDE });
    const s = side(json().data, "plans/r.mdx")!;
    expect(s.tilstand).toBe("endret");
    expect(s.endredeFiler).toEqual(["plans/rapport/Q-1.csv"]);
    expect(s.advarsler).toEqual(["plans/rapport/Q-1.csv: ikke lastet opp ennå"]);
  });

  test("en CSV som bare skiller seg fra bøtta ved den fjernede identkolonnen, er uendret", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", CSV_MED_IDENT);
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV_STRIPPET });
    expect(side(json().data, "plans/r.mdx")!.tilstand).toBe("uendret");
  });

  test("ligger den uskrubbede kildefilen i bøtta, er CSV-en endret (sammenligningen bruker kopien)", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", CSV_MED_IDENT);
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV_MED_IDENT });
    const { data, stdout } = json();
    expect(side(data, "plans/r.mdx")!.endredeFiler).toEqual(["plans/rapport/Q-1.csv"]);
    expect(stdout).not.toContain("Z990123");
  });

  test("mangler-lokalt: siden er i bøtta, ikke under roten", () => {
    bøtte({ "plans/borte.md": "# Borte\n" });
    const r = kjør(["--status", rot]);
    expect(r.kode).toBe(0);
    expect(r.ut).toMatch(/MANGLER LOKALT +plans\/borte\.md/);
    expect(side(json().data, "plans/borte.md")!.tilstand).toBe("mangler-lokalt");
  });

  test("avvist: et fødselsnummer i en datafil avviser siden; avslaget står én gang med stien", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", `a,fnr\n1,${FNR}\n`);
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV });
    const { data, stdout } = json();
    const s = side(data, "plans/r.mdx")!;
    expect(s.tilstand).toBe("avvist");
    expect(s.endredeFiler).toEqual([]);
    expect(s.avslag.length).toBeGreaterThan(0);
    for (const a of s.avslag) expect(a.startsWith("plans/rapport/Q-1.csv:")).toBe(true);
    expect(s.avslag.some((a) => a.startsWith("plans/rapport/Q-1.csv: plans/"))).toBe(false);
    expect(stdout).not.toContain(FNR);
  });

  test("--tillat-ident endrer bare avvist-klassifiseringen for en NAVident i siden", () => {
    const tekst = "# Side\nbehandlet av Z990123\n";
    skriv("a.md", tekst);
    bøtte({ "a.md": tekst });
    expect(side(json().data, "a.md")!.tilstand).toBe("avvist");
    const s = side(json(["--tillat-ident"]).data, "a.md")!;
    expect(s.tilstand).toBe("uendret");
    expect(s.advarsler.some((a) => a.includes("tillatt med --tillat-ident"))).toBe(true);
  });

  test("et objekt uten MD5 (sammensatt) regnes som endret, med en merknad", () => {
    skriv("a.md", "# A\n");
    bøtte({ "a.md": null });
    const s = side(json().data, "a.md")!;
    expect(s.tilstand).toBe("endret");
    expect(s.endredeFiler).toEqual(["a.md"]);
    expect(s.advarsler[0]).toContain("ingen MD5");
  });

  test("foreldreløs datafil: i bøtta, men ingen fulgt side viser den; --fjern-linjen foreslås", () => {
    skriv("a.md", "# A\n");
    bøtte({ "a.md": "# A\n", "data/gammel.csv": CSV, "data/gammel.sql": "select 1;\n" });
    const r = kjør(["--status", rot]);
    expect(r.kode).toBe(0);
    expect(r.ut).toMatch(/FORELDRELØS +data\/gammel\.csv/);
    expect(r.ut).toContain("--fjern -- data/gammel.csv data/gammel.sql");
    expect(json().data.foreldreløse).toEqual(["data/gammel.csv", "data/gammel.sql"]);
  });

  test("leserkonfigen på rotnivå følges, en i en mappe og ikke-gjeldende versjoner gjør ikke", () => {
    skriv(".wiki-reader.json", '{"a":1}\n');
    bøtte({ ".wiki-reader.json": '{"a":0}\n', "x/.wiki-reader.json": "{}" }, [{ name: "b.md", md5_hash: md5("x"), noncurrent_time: "2026-01-01" }]);
    const { data } = json();
    expect(data.sider.map((s) => [s.relPath, s.tilstand])).toEqual([[".wiki-reader.json", "endret"]]);
  });

  test("JSON: ett objekt med bøtte, sortert sideliste og maskert sti med funn", () => {
    skriv("b.md", "# B\n");
    skriv("a/Z990123.md", "# Ident i navnet\n");
    bøtte({ "b.md": "# B\n", "a/Z990123.md": "# gammel\n", "data/Z990124.csv": CSV });
    const { kode, data, stdout } = json(["--tillat-ident"]);
    expect(kode).toBe(0);
    expect(Object.keys(data)).toEqual(["bøtte", "sider", "foreldreløse"]);
    expect(data.bøtte).toBe("felles-test");
    expect(data.sider.map((s) => s.relPath)).toEqual(["[skjult sti: inneholder NAVident]", "b.md"]);
    expect(data.sider[0]).toMatchObject({ tilstand: "endret", endredeFiler: ["[skjult sti: inneholder NAVident]"] });
    expect(data.foreldreløse).toEqual(["[skjult sti: inneholder NAVident]"]);
    expect(stdout).not.toMatch(/Z99012/);
  });

  test("tekstutdata skjuler også stier med funn, og foreslår ikke --fjern for dem", () => {
    bøtte({ "data/Z990124.csv": CSV });
    const r = kjør(["--status", rot]);
    expect(r.ut).not.toMatch(/Z99012/);
    expect(r.ut).not.toContain("--fjern --");
  });

  test("feiler listingen: exit 2, tom stdout med --json", () => {
    writeFileSync(path.join(falsk, "liste-feil"), "");
    const r = kjør(["--status", "--json", rot]);
    expect(r.kode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.ut).toContain("falsk listefeil");
  });
});

describe("--synk", () => {
  function toSider() {
    skriv("a.md", "# A ny\n");
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", CSV_MED_IDENT);
    bøtte({ "a.md": "# A\n", "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV_STRIPPET });
  }

  test("laster opp bare de endrede sidene", () => {
    toSider();
    const r = kjør(["--synk", rot]);
    expect(r.kode).toBe(0);
    expect(destinasjoner()).toEqual(["gs://felles-test/a.md"]);
    expect(r.ut).toContain("Synker 1 endret(e) side(r)");
  });

  test("en endret datafil laster opp siden med datafilen, CSV-en uten identkolonnen", () => {
    skriv("plans/r.mdx", SIDE);
    skriv("plans/rapport/Q-1.csv", "a,b,endret_av\n1,9,Z990123\n");
    bøtte({ "plans/r.mdx": SIDE, "plans/rapport/Q-1.csv": CSV_STRIPPET });
    const r = kjør(["--synk", rot]);
    expect(r.kode).toBe(0);
    expect(destinasjoner()).toEqual(["gs://felles-test/plans/r.mdx", "gs://felles-test/plans/rapport/Q-1.csv"]);
    expect(kall().find((k) => k.args.at(-1)?.endsWith("Q-1.csv"))!.stdin).toBe("a,b\n1,9\n");
  });

  test("--dry-run laster ingenting opp", () => {
    toSider();
    const r = kjør(["--synk", "--dry-run", rot]);
    expect(r.kode).toBe(0);
    expect(destinasjoner()).toEqual([]);
    expect(r.ut).toContain("vil laste opp gs://felles-test/a.md");
    expect(r.ut).not.toContain("vil laste opp gs://felles-test/plans/r.mdx");
  });

  test("ingenting endret: sier det og gir exit 0", () => {
    skriv("a.md", "# A\n");
    bøtte({ "a.md": "# A\n" });
    const r = kjør(["--synk", rot]);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain("Ingenting å synke");
    expect(destinasjoner()).toEqual([]);
  });

  test("en avvist side publiseres ikke og gir exit 1; den endrede lastes opp", () => {
    skriv("a.md", "# A ny\n");
    skriv("b.md", "# B\nav Z990123\n");
    bøtte({ "a.md": "# A\n", "b.md": "# B gammel\n", "borte.md": "# borte\n" });
    const r = kjør(["--synk", rot]);
    expect(r.kode).toBe(1);
    expect(destinasjoner()).toEqual(["gs://felles-test/a.md"]);
    expect(r.ut).toMatch(/AVVIST +b\.md/);
    expect(r.ut).toMatch(/MANGLER LOKALT +borte\.md/);
  });

  test("--tillat-ident slipper siden med NAVident gjennom i synk også", () => {
    skriv("b.md", "# B\nav Z990123\n");
    bøtte({ "b.md": "# B gammel\n" });
    const r = kjør(["--synk", "--tillat-ident", rot]);
    expect(r.kode).toBe(0);
    expect(destinasjoner()).toEqual(["gs://felles-test/b.md"]);
  });
});

describe("flagg", () => {
  test.each([
    [["--json", "ROT"], "--json gjelder bare --status"],
    [["--synk", "--json", "ROT"], "--json gjelder bare --status"],
    [["--status", "ROT", "a.md"], "--status tar nøyaktig én sti"],
    [["--synk"], "--synk tar nøyaktig én sti"],
    [["--status", "--synk", "ROT"], "kan ikke kombineres"],
    [["--fjern", "--status", "a.md"], "kan ikke kombineres"],
    [["--status", "--dry-run", "ROT"], "--dry-run gjelder ikke --status"],
    [["--status", "--ja", "ROT"], "--ja gjelder bare --fjern"],
  ])("%p avvises med exit 2", (args, melding) => {
    const r = kjør(args.map((a) => (a === "ROT" ? rot : a)));
    expect(r.kode).toBe(2);
    expect(r.ut).toContain(melding);
    expect(kall()).toEqual([]);
  });
});
