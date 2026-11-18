import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const BIN_NAME = PACKAGE_NAME.slice(PACKAGE_NAME.lastIndexOf("/") + 1).split("-")[0];

const root = dirname(dirname(realpathSync(new URL(import.meta.url))));
const binPath = realpathSync(execFileSync("which", [process.env.PI_JOBS_BIN ?? BIN_NAME], { encoding: "utf8" }).trim());
const prefix = dirname(dirname(binPath));

function isPackage(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PACKAGE_NAME;
	} catch {
		return false;
	}
}

const packageRoot = [
	process.env.PI_JOBS_PACKAGE_ROOT,
	prefix,
	join(prefix, "lib/node_modules/pi-monorepo"),
	join(prefix, "lib/node_modules", PACKAGE_NAME),
	join(prefix, "node_modules", PACKAGE_NAME),
]
	.filter((candidate) => candidate && isPackage(candidate))
	.at(0);

if (!packageRoot) {
	console.error(`Could not locate ${PACKAGE_NAME} from ${binPath}. Set PI_JOBS_PACKAGE_ROOT.`);
	process.exit(1);
}

const installed = join(packageRoot, "node_modules");

const targets = {
	[PACKAGE_NAME]: packageRoot,
	"@earendil-works/pi-ai": join(installed, "@earendil-works/pi-ai"),
	"@earendil-works/pi-tui": join(installed, "@earendil-works/pi-tui"),
	typebox: join(installed, "typebox"),
	jiti: join(installed, "jiti"),
	"@types/node": join(installed, "@types/node"),
};

for (const [name, source] of Object.entries(targets)) {
	const link = join(root, "node_modules", name);
	if (!existsSync(source)) {
		console.error(`missing ${source}`);
		process.exit(1);
	}
	mkdirSync(dirname(link), { recursive: true });
	if (lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { recursive: true, force: true });
	symlinkSync(source, link, "dir");
	console.log(`${name} -> ${source}`);
}
