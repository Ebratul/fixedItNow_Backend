import { DEFAULT_ROLES } from "../src/admin/permissions.js";
import { createScriptClient } from "../scripts/db.js";

/**
 * Seeds reference data only (service categories, starting admin roles). Idempotent. Contains no users,
 * no workers, and no credentials.
 */
const CATEGORIES = [
  ["electrical", "Electrical Services", "Wiring, switches, fans, lighting, and fault finding."],
  ["plumbing", "Plumbing", "Leaks, taps, pipes, drainage, and bathroom fittings."],
  ["ac-repair", "AC Repair & Servicing", "Air conditioner servicing, gas refill, and repairs."],
  ["home-cleaning", "Home Cleaning", "Deep cleaning for homes, kitchens, and bathrooms."],
  ["appliance-repair", "Appliance Repair", "Fridges, washing machines, ovens, and other appliances."],
  ["painting", "Painting", "Interior and exterior painting and wall finishing."],
  ["carpentry", "Carpentry", "Furniture repair, fittings, doors, and woodwork."],
  ["moving-shifting", "Moving & Shifting", "Packing, loading, and home or office relocation."],
  ["pest-control", "Pest Control", "Treatment for cockroaches, termites, rodents, and more."],
  ["computer-it", "Computer & IT Support", "Laptop and desktop repair, networking, and setup help."],
] as const;

const prisma = createScriptClient();
try {
  for (const [index, [slug, name, description]] of CATEGORIES.entries()) {
    await prisma.serviceCategory.upsert({
      where: { slug },
      create: { slug, name, description, sortOrder: index },
      update: { name, description, sortOrder: index },
    });
  }
  console.log(`Seeded ${CATEGORIES.length} service categories.`);

  // Starting admin roles. Created only when missing: edits made in the admin panel are never overwritten.
  let created = 0;
  for (const role of DEFAULT_ROLES) {
    const exists = await prisma.adminRole.findUnique({ where: { key: role.key }, select: { id: true } });
    if (exists) continue;
    await prisma.adminRole.create({ data: { key: role.key, name: role.name, description: role.description, permissions: role.permissions } });
    created += 1;
  }
  console.log(`Admin roles: ${created} created, ${DEFAULT_ROLES.length - created} already present.`);
} finally {
  await prisma.$disconnect();
}
