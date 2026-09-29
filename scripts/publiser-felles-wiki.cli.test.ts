// Kjører skriptet som en egen prosess med en falsk `gcloud` først på PATH.
// Den falske skriver ned argumentene og det den fikk på stdin, svarer på
// `storage objects list` fra en fil, og feiler på destinasjoner testen ber om.
// Ingen test her når Google.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SKRIPT = path.join(import.meta.dir, "publiser-felles-wiki.ts");

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

const FALSK_GCLOUD = `#!/bin/bash
d="$FAKE_GCLOUD_DIR"
n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/n"
printf '%s\\n' "$@" > "$d/kall-$n.args"
if [ "$1 $2 $3" = "storage objects list" ]; then cat "$d/liste.json" 2>/dev/null || echo "[]"; exit 0; fi
last="\${@: -1}"
for a in "$@"; do if [ "$a" = "-" ]; then cat > "$d/kall-$n.stdin"; fi; done
if [ -f "$d/feil" ] && grep -qxF -- "$last" "$d/feil"; then echo "falsk feil" >&2; exit 1; fi
exit 0
`;

let tmp: string;
let rot: string;
let falsk: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "felles-wiki-cli-"));
  rot = path.join(tmp, "wiki");
  falsk = path.join(tmp, "falsk");
  mkdirSync(rot);
  mkdirSync(path.join(tmp, "bin"));
  mkdirSync(falsk);
  writeFileSync(path.join(tmp, "bin", "gcloud"), FALSK_GCLOUD);
  chmodSync(path.join(tmp, "bin", "gcloud"), 0o755);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function skriv(rel: string, innhold: string): string {
  const abs = path.join(rot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, innhold);
  return abs;
}

function kjør(args: string[], env: Record<string, string> = {}, stdin = "") {
  const r = Bun.spawnSync(["bun", SKRIPT, ...args], {
    env: { ...process.env, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, FAKE_GCLOUD_DIR: falsk, FELLES_WIKI_BUCKET: "felles-test", ...env },
    stdin: new TextEncoder().encode(stdin),
  });
  return { kode: r.exitCode, ut: r.stdout.toString() + r.stderr.toString() };
}

interface Kall {
  args: string[];
  stdin: Buffer | null;
}
function kall(): Kall[] {
  const ut: Kall[] = [];
  const n = existsSync(path.join(falsk, "n")) ? Number(readFileSync(path.join(falsk, "n"), "utf8")) : 0;
  for (let i = 1; i <= n; i++) {
    const args = readFileSync(path.join(falsk, `kall-${i}.args`), "utf8").split("\n").slice(0, -1);
    const s = path.join(falsk, `kall-${i}.stdin`);
    ut.push({ args, stdin: existsSync(s) ? readFileSync(s) : null });
  }
  return ut;
}
const opplastinger = () => kall().filter((k) => k.args[0] === "storage" && k.args[1] === "cp");
const destinasjoner = () => opplastinger().map((k) => k.args.at(-1));

describe("opplasting", () => {
  test("laster opp nøyaktig de skannede byteene via stdin, ikke fra en lokal sti", () => {
    skriv("a.md", "# Ren side\n");
    const r = kjør([rot, "a.md"]);
    expect(r.kode).toBe(0);
    const [k] = opplastinger();
    expect(k!.args).toContain("-");
    expect(k!.args.some((a) => a.startsWith(rot))).toBe(false);
    expect(k!.args.at(-1)).toBe("gs://felles-test/a.md");
    expect(k!.stdin?.toString()).toBe("# Ren side\n");
  });

  test("relPath med jokertegn avvises og lastes ikke opp", () => {
    skriv("a[1].md", "# Ren side\n");
    skriv("a1.md", `# Uskannet søsken ${FNR}\n`);
    const r = kjør([rot, "a[1].md"]);
    expect(r.kode).toBe(1);
    expect(opplastinger()).toEqual([]);
  });

  test("en feilet opplasting stopper ikke resten, og gir exit 3 med oppsummering", () => {
    skriv("a.md", "# A\n");
    skriv("b.md", "# B\n");
    writeFileSync(path.join(falsk, "feil"), "gs://felles-test/a.md\n");
    const r = kjør([rot, "a.md", "b.md"]);
    expect(r.kode).toBe(3);
    expect(destinasjoner()).toEqual(["gs://felles-test/a.md", "gs://felles-test/b.md"]);
    expect(r.ut).toMatch(/1 lastet opp/);
    expect(r.ut).toMatch(/1 feilet/);
  });

  test("objektnavnet NFC-normaliseres", () => {
    const nfd = "cafe\u0301.md";
    skriv(nfd, "# Kafé\n");
    expect(kjør([rot, nfd]).kode).toBe(0);
    expect(destinasjoner()).toEqual([`gs://felles-test/${"café.md".normalize("NFC")}`]);
  });

  test("navn som kolliderer med et annet eksisterende objekt under små bokstaver avvises", () => {
    skriv("plans/a.md", "# A\n");
    writeFileSync(path.join(falsk, "liste.json"), JSON.stringify([{ name: "Plans/A.md" }]));
    const r = kjør([rot, "plans/a.md"]);
    expect(r.kode).toBe(1);
    expect(r.ut).toContain("--fjern");
    expect(opplastinger()).toEqual([]);

    // Samme navn som det eksisterende er en vanlig overskriving.
    writeFileSync(path.join(falsk, "liste.json"), JSON.stringify([{ name: "plans/a.md" }]));
    expect(kjør([rot, "plans/a.md"]).kode).toBe(0);
    expect(destinasjoner()).toEqual(["gs://felles-test/plans/a.md"]);
  });

  test("symlenke inne i roten avvises", () => {
    skriv("ekte.md", "# Ekte\n");
    symlinkSync(path.join(rot, "ekte.md"), path.join(rot, "lenke.md"));
    const r = kjør([rot, "lenke.md"]);
    expect(r.kode).toBe(1);
    expect(opplastinger()).toEqual([]);
  });

  test("en mappe som er en symlenke avvises", () => {
    skriv("ekte/a.md", "# Ekte\n");
    symlinkSync(path.join(rot, "ekte"), path.join(rot, "lenkemappe"));
    const r = kjør([rot, "lenkemappe/a.md"]);
    expect(r.kode).toBe(1);
    expect(opplastinger()).toEqual([]);
  });

  test("bilder en side viser, lastes ikke opp", () => {
    skriv("side.md", "# Side\n\n![fig](bilde.png)\n");
    skriv("bilde.png", "ikke egentlig png");
    expect(kjør([rot, "side.md"]).kode).toBe(0);
    expect(destinasjoner()).toEqual(["gs://felles-test/side.md"]);
  });
});

describe("maskering", () => {
  test("et fødselsnummer i filnavnet skrives aldri ut, og filen avvises", () => {
    const rel = `sak-${FNR}.md`;
    skriv(rel, "# Ren tekst\n");
    const r = kjør([rot, rel]);
    expect(r.kode).toBe(1);
    expect(r.ut).not.toContain(FNR);
    expect(r.ut).not.toContain(FNR.slice(0, 6));
    expect(opplastinger()).toEqual([]);
  });
});

describe("argumenter og bøtte", () => {
  test("tom FELLES_WIKI_BUCKET faller tilbake til vars-q2.json", () => {
    skriv("a.md", "# A\n");
    const r = kjør(["--dry-run", rot, "a.md"], { FELLES_WIKI_BUCKET: "" });
    expect(r.kode).toBe(0);
    expect(r.ut).toContain("gs://melosys-felles-wiki-q2/a.md");
  });

  test("-- skiller flagg fra relPath", () => {
    skriv("-rar.md", "# Rar\n");
    const r = kjør(["--dry-run", "--", rot, "-rar.md"]);
    expect(r.kode).toBe(0);
    expect(r.ut).toContain("gs://felles-test/-rar.md");
  });
});

describe("--fjern", () => {
  test("sletter med --ja, og tørrkjører uten å slette", () => {
    const tørr = kjør(["--fjern", "--dry-run", "a.md", "b/c.mdx"]);
    expect(tørr.kode).toBe(0);
    expect(tørr.ut).toContain("gs://felles-test/b/c.mdx");
    expect(kall().filter((k) => k.args[1] === "rm")).toEqual([]);

    const r = kjør(["--fjern", "--ja", "a.md", "b/c.mdx"]);
    expect(r.kode).toBe(0);
    expect(kall().filter((k) => k.args[1] === "rm").map((k) => k.args.at(-1))).toEqual(["gs://felles-test/a.md", "gs://felles-test/b/c.mdx"]);
  });

  test("sletter bare etter et ja på spørsmålet", () => {
    const nei = kjør(["--fjern", "a.md"], {}, "n\n");
    expect(nei.kode).toBe(1);
    expect(readdirSync(falsk).filter((f) => f.startsWith("kall-"))).toEqual([]);
    const ja = kjør(["--fjern", "a.md"], {}, "j\n");
    expect(ja.kode).toBe(0);
    expect(kall().filter((k) => k.args[1] === "rm").map((k) => k.args.at(-1))).toEqual(["gs://felles-test/a.md"]);
  });
});
