// Kjører jq-programmet fra deploy.yml-steget «The felles-wiki values have a
// usable shape» mot syntetiske vars-filer, så vakten testes slik den står i
// arbeidsflyten og ikke som en avskrift.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const yml = readFileSync(path.join(import.meta.dir, "..", ".github", "workflows", "deploy.yml"), "utf8");
const steg = yml.slice(yml.indexOf("- name: The felles-wiki values have a usable shape"));
const program = /BAD=\$\(jq -r '([\s\S]*?)' deploy\/nais\/vars\.json\)/.exec(steg)?.[1];

const tmp = mkdtempSync(path.join(tmpdir(), "deploy-vakt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function vakt(vars: Record<string, unknown>): string {
  const fil = path.join(tmp, "vars.json");
  writeFileSync(fil, JSON.stringify(vars));
  const r = Bun.spawnSync(["jq", "-r", program!, fil]);
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
}

const GOD_BØTTE = "melosys-felles-wiki";

describe.skipIf(!Bun.which("jq"))("deploy.yml: felles_wiki_project_number", () => {
  test("programmet finnes i steget", () => {
    expect(program).toBeDefined();
  });
  test.each([["594181726752"], ["1"], ["12345678901234567890"]])("%s godtas", (nr) => {
    expect(vakt({ felles_wiki_bucket: GOD_BØTTE, felles_wiki_project_number: nr })).toBe("");
  });
  test.each([["0"], ["0594181726752"], ["123456789012345678901"], [""], ["12a"], ["12\n"]])("%j avvises, som muninn sin parser gjør", (nr) => {
    expect(vakt({ felles_wiki_bucket: GOD_BØTTE, felles_wiki_project_number: nr })).toContain("felles_wiki_project_number");
  });
  test("et tall i stedet for en streng avvises", () => {
    expect(vakt({ felles_wiki_bucket: GOD_BØTTE, felles_wiki_project_number: 594181726752 })).toContain("felles_wiki_project_number");
  });
});
