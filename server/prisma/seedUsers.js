// Creates one login per role, plus a DRIVER account linked to a real driver
// record so the self-service portal (ISSUES #37) can be demonstrated.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// Satisfies the shared password policy: 8+ characters, a letter and a digit.
const DEFAULT_PASSWORD = "Password@123";

const USERS = [
  { username: "admin",            email: "admin@transitops.com",            role: "ADMIN", password: "Admin@12345" },
  { username: "fleetmanager",     email: "fleetmanager@transitops.com",     role: "FLEET_MANAGER" },
  { username: "dispatcher",       email: "dispatcher@transitops.com",       role: "DISPATCHER" },
  { username: "safetyofficer",    email: "safetyofficer@transitops.com",    role: "SAFETY_OFFICER" },
  { username: "financialanalyst", email: "financialanalyst@transitops.com", role: "FINANCIAL_ANALYST" },
];

// Linked to the seeded driver with this licence number, if it exists.
const DRIVER_USER = {
  username: "driver",
  email: "rajesh.kumar@transitops-drivers.com",
  role: "DRIVER",
  licenseNumber: "DL-0420110012345",
};

async function main() {
  console.log("Seeding users...\n");

  for (const u of USERS) {
    const password = u.password || DEFAULT_PASSWORD;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { role: u.role, username: u.username },
      create: { email: u.email, username: u.username, password: hashedPassword, role: u.role },
    });

    console.log(`${u.role.padEnd(18)} ${user.email.padEnd(34)} ${password}`);
  }

  // The driver login only makes sense once seed:data has created the driver.
  const driver = await prisma.driver.findUnique({
    where: { licenseNumber: DRIVER_USER.licenseNumber },
  });

  if (!driver) {
    console.log(
      `\n⚠  DRIVER account skipped — run "npm run seed:data" first to create driver ${DRIVER_USER.licenseNumber}.`
    );
  } else {
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    const driverUser = await prisma.user.upsert({
      where: { email: DRIVER_USER.email },
      update: { role: "DRIVER", username: DRIVER_USER.username },
      create: {
        email: DRIVER_USER.email,
        username: DRIVER_USER.username,
        password: hashedPassword,
        role: "DRIVER",
      },
    });

    await prisma.driver.update({
      where: { id: driver.id },
      data: { userId: driverUser.id },
    });

    console.log(`${"DRIVER".padEnd(18)} ${driverUser.email.padEnd(34)} ${DEFAULT_PASSWORD}`);
    console.log(`${"".padEnd(18)} └─ linked to driver ${driver.name}`);
  }

  console.log("\n✅ Users seeded.");
}

main()
  .catch((e) => {
    console.error("\n❌ User seed failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
