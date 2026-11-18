import Module from "node:module";

/**
 * Strip TypeScript types for in-memory slice tests across both Node.js
 * (`module.stripTypeScriptTypes`, Node >= 22.6) and Bun (`Bun.Transpiler`).
 */
export function transpileTs(code: string): string {
	const strip = (
		Module as unknown as {
			stripTypeScriptTypes?: (src: string) => string;
		}
	).stripTypeScriptTypes;
	if (typeof strip === "function") {
		return strip(code);
	}
	const bunGlobal = (
		globalThis as unknown as {
			Bun?: {
				Transpiler: new (opts: { loader: string; target: string }) => {
					transformSync: (src: string) => string;
				};
			};
		}
	).Bun;
	if (bunGlobal?.Transpiler) {
		return new bunGlobal.Transpiler({
			loader: "ts",
			target: "node",
		}).transformSync(code);
	}
	throw new Error("Neither module.stripTypeScriptTypes nor Bun.Transpiler is available");
}
