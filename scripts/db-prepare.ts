import { config } from "dotenv";

config({ quiet: true });

async function main() {
  const { migrate } = await import("../src/lib/db/migrate");
  const { seed } = await import("../src/lib/db/seed");
  const applied = await migrate();
  await seed();
  console.log(applied.length ? `applied ${applied.join(", ")}` : "migrations already applied");
  console.log("seeded inboxes and settings");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
