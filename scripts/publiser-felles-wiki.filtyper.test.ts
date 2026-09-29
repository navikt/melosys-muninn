// Alle filtyper vurderFil kan møte, med forventet utfall. Tabellen er hele
// tilstandsrommet for åpningen: vanlig fil, mappe, symlenke, FIFO, manglende,
// uleselig og for stor fil.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vurderFil } from "./publiser-felles-wiki.ts";

const rot = mkdtempSync(path.join(tmpdir(), "filtyper-"));
afterAll(() => {
  try { chmodSync(path.join(rot, "ulesbar.md"), 0o644); } catch {}
  rmSync(rot, { recursive: true, force: true });
});
writeFileSync(path.join(rot, "vanlig.md"), "# Side\n\nHei.\n");
mkdirSync(path.join(rot, "mappe.md"));
symlinkSync("vanlig.md", path.join(rot, "lenke.md"));
Bun.spawnSync(["mkfifo", path.join(rot, "fifo.md")]);
writeFileSync(path.join(rot, "stor.md"), "a".repeat(2 * 1024 * 1024 + 1));
writeFileSync(path.join(rot, "ulesbar-Z990123.md"), "# x\n");
chmodSync(path.join(rot, "ulesbar-Z990123.md"), 0o000);
const erRot = process.getuid?.() === 0;

describe("vurderFil over alle filtyper", () => {
  const tilfeller: [string, RegExp | null][] = [
    ["vanlig.md", null],
    ["mappe.md", /ikke en vanlig fil/],
    ["lenke.md", /symlenke/],
    ["fifo.md", /ikke en vanlig fil/],
    ["mangler.md", /finnes ikke/],
    ["stor.md", /større enn/],
  ];
  for (const [navn, forventet] of tilfeller) {
    test(`${navn} → ${forventet ?? "godkjent"}`, () => {
      const v = vurderFil(path.join(rot, navn), navn, false);
      if (forventet) expect(v.avslag.join("\n")).toMatch(forventet);
      else expect(v.avslag).toEqual([]);
    }, 3000);
  }
  test.skipIf(erRot)("uleselig fil gir avslag med feilkode, og navnet vises bare maskert", () => {
    const v = vurderFil(path.join(rot, "ulesbar-Z990123.md"), "ulesbar-Z990123.md", true, 1);
    expect(v.avslag.join("\n")).toMatch(/kan ikke leses \(EACCES\)/);
    expect(JSON.stringify(v.avslag)).not.toContain("Z990123");
  });
});
