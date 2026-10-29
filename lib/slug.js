// Slug para anclas: minúsculas, sin tildes ni espacios (ej. "Carrefour -
// Brasil" -> "carrefour-brasil"). uniqueSlugs agrega -2, -3… si se repite
// dentro del mismo envío (spec §10.3).
function slugify(value) {
  const slug = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'organization';
}

function uniqueSlugs(names) {
  const used = new Map();
  return names.map((name) => {
    const base = slugify(name);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

module.exports = { slugify, uniqueSlugs };
