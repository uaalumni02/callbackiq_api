const translations = [
  [/\b(?:huele|olor|hedor) (?:a |de )?gas\b/g, "smell gas"],
  [/\bfuga de gas\b/g, "gas leak"],
  [/\b(?:mi|nuestra|la) casa\b/g, "my house"],
  [/\bse esta inundando\b/g, "is flooding"],
  [/\b(?:inundacion|inundandose)\b/g, "flooding"],
  [/\bhumo\b/g, "smoke"],
  [/\bfuego\b/g, "fire"],
  [/\bchispas\b/g, "sparking"],
  [
    /\b(?:mi )?(?:bebe|nino|nina|mascota)\b[^.!?;]{0,20}\b(?:encerrad[oa]|atrapad[oa])\b[^.!?;]{0,20}\b(?:coche|auto|carro|vehiculo)\b/g,
    "child locked inside car",
  ],
  [/\bayer\b/g, "yesterday"],
  [/\banoche\b/g, "last night"],
  [/\bantes\b/g, "earlier"],
  [/\bya no\b/g, "no longer"],
  [/\bya se (?:detuvo|resolvio)\b/g, "resolved"],
  [/\bno hay\b/g, "no"],
  [/\bpero\b/g, "but"],
  [/\bahora\b/g, "now"],
  [/\btodavia\b/g, "still"],
];
/** Normalizes bounded safety wording while preserving negation, time and the original stored customer text. */
export function normalizeSafetyLanguage(value) {
  const text = String(value || "")
    .slice(0, 4000)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
  return translations.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}
