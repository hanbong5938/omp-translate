/**
 * Separate-process settings writer for cross-process tests.
 *
 *   bun test/fixtures/settings-writer.ts update <path> <json-patch>
 *     load the store, print READY, wait for GO on stdin, update(patch), print the result JSON on one line.
 *   bun test/fixtures/settings-writer.ts hold <path>
 *     acquire the settings file lock, print HELD, wait for RELEASE on stdin, release.
 *
 * Any failure is written to stderr and exits nonzero.
 */
import * as z from "@oh-my-pi/omptype/zod";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { SettingsStore, type TranslationSettings } from "../../src/settings.ts";

async function print(line: string): Promise<void> {
	await Bun.write(Bun.stdout, `${line}\n`);
}

async function waitForLine(expected: string): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk, { stream: true });
		const newline = buffer.indexOf("\n");
		if (newline === -1) continue;
		const line = buffer.slice(0, newline);
		if (line === expected) return;
		throw new Error(`Expected ${JSON.stringify(expected)} on stdin, got ${JSON.stringify(line)}`);
	}
	throw new Error(`stdin closed before ${JSON.stringify(expected)}`);
}

async function update(filePath: string, patchJson: string): Promise<void> {
	const patch = JSON.parse(patchJson) as Partial<TranslationSettings>;
	const store = new SettingsStore({ path: filePath, zod: z });
	const loaded = await store.load();
	if (loaded.status === "invalid") throw new Error(loaded.error);
	await print("READY");
	await waitForLine("GO");
	const result = await store.update(patch);
	await print(JSON.stringify(result));
}

async function hold(filePath: string): Promise<void> {
	const lock = await acquireFileLock(filePath);
	try {
		await print("HELD");
		await waitForLine("RELEASE");
	} finally {
		lock.release();
	}
}

async function main(): Promise<void> {
	const [mode, filePath, patchJson] = process.argv.slice(2);
	if (mode === "update" && filePath !== undefined && patchJson !== undefined) return update(filePath, patchJson);
	if (mode === "hold" && filePath !== undefined) return hold(filePath);
	throw new Error("Usage: settings-writer.ts update <path> <json-patch> | hold <path>");
}

try {
	await main();
	process.exit(0);
} catch (error) {
	await Bun.write(Bun.stderr, `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
}
