/**
 * Skanner for svar på `<Question>`-kort i melosys-felles, lastet av muninn
 * gjennom `WIKI_ANSWER_SCANNER`. muninn importerer denne modulen og kaller
 * `scanAnswer(tekst)` med hele svaret før det lagres: en tom liste slipper
 * svaret gjennom, hvert element avviser det (HTTP 422) og vises brukeren.
 *
 * Samme skanner som publiseringsskriptet bruker på en side, linje for linje,
 * og samme regel som `--tillat-ident`: e-post og NAVident slipper gjennom,
 * alt annet (fødselsnummer, D-nummer, H-nummer, organisasjonsnummer) avvises.
 * Verdien vises bare maskert, så brukeren ser hva som må fjernes uten at
 * nummeret skrives ut i sin helhet.
 *
 * I imaget ligger filen i /app/nais-skanner/build/ og skriptet i
 * /app/nais-skanner/scripts/, samme innbyrdes plassering som i dette repoet,
 * så importen under virker begge steder.
 */
import { skannTekst } from "../scripts/publiser-felles-wiki.ts";

export interface SvarAvslag {
  reason: string;
}

export function scanAnswer(text: string): SvarAvslag[] {
  // Feil type er en programfeil hos kalleren. Et kast gjør at muninn avviser
  // alle svar (503), som er riktig retning.
  if (typeof text !== "string") throw new TypeError(`scanAnswer forventer en streng, fikk ${typeof text}`);
  const avslag: SvarAvslag[] = [];
  for (const f of skannTekst(text)) {
    if (f.ident) continue;
    const antall = f.antall > 1 ? ` (${f.antall} forekomster)` : "";
    avslag.push({ reason: `linje ${f.linje}: ${f.type} ${f.maskert}${antall}` });
  }
  return avslag;
}
