import { migrateDatabase, readDatabaseCompatibility } from "./database-backup.js";

export async function migrateManagedDatabase({ sourcePath, destinationPath }) {
  const source = await readDatabaseCompatibility(sourcePath);
  if (!source.exists) {
    const error = new Error(`source database does not exist: ${sourcePath}`);
    error.code = "migration_source_missing";
    throw error;
  }
  const migrated = await migrateDatabase({ sourcePath, destinationPath });
  const destination = await readDatabaseCompatibility(destinationPath);
  return Object.freeze({
    sourceSchema: source.schemaVersion,
    destinationSchema: destination.schemaVersion,
    sourceQuickCheck: source.quickCheck,
    destinationQuickCheck: destination.quickCheck,
    migrated: migrated.destinationPath,
  });
}
