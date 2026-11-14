import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export function readRegistry<T>(file: string): T[] | undefined {
  try {
    const records: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(records) || records.some((record) => !record || typeof record.id !== "string" || !record.id)) {
      throw new Error("invalid registry records");
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(file, { throwIfNoEntry: false })) return undefined;
    throw new Error(`Cannot load ${basename(file)}. Repair the registry or restore a backup before restarting.`);
  }
}
