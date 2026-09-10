import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { ParsedWorkflow, WorkflowMeta, WorkflowMetaPhase, WorkflowPermissions } from "./types.ts";

type AstNode = Node & Record<string, unknown>;

interface ProgramNode extends AstNode {
	body: AstNode[];
}

const RESERVED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_IDENTIFIERS = new Set(["Proxy", "Reflect", "WebAssembly"]);
const RESERVED_REFLECTION_PROPERTIES = new Set([
	"create",
	"defineProperties",
	"defineProperty",
	"getOwnPropertyDescriptor",
	"getOwnPropertyDescriptors",
	"getOwnPropertyNames",
	"getOwnPropertySymbols",
	"getPrototypeOf",
	"setPrototypeOf",
]);

function isAstNode(value: unknown): value is AstNode {
	return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function childNodes(node: AstNode): AstNode[] {
	const children: AstNode[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (["start", "end", "loc", "range"].includes(key)) continue;
		if (Array.isArray(value)) children.push(...value.filter(isAstNode));
		else if (isAstNode(value)) children.push(value);
	}
	return children;
}

function identifierName(node: unknown): string | undefined {
	if (!isAstNode(node) || node.type !== "Identifier") return undefined;
	return typeof node.name === "string" ? node.name : undefined;
}

function staticPropertyName(node: AstNode): string | undefined {
	const property = node.property;
	const direct = identifierName(property);
	if (direct && node.computed !== true) return direct;
	if (isAstNode(property) && property.type === "Literal" && typeof property.value === "string") {
		return property.value;
	}
	return undefined;
}

function assertDeterministic(node: AstNode): void {
	if (node.type === "Identifier" && typeof node.name === "string" && RESERVED_IDENTIFIERS.has(node.name)) {
		throw new Error(`Workflow identifier ${node.name} is unavailable.`);
	}
	if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
		throw new Error("Workflow imports are unavailable; use injected DSL globals.");
	}
	if (node.type === "ThisExpression") throw new Error("Workflow top-level this is unavailable.");
	if (node.type === "CallExpression") {
		const calleeName = identifierName(node.callee);
		if (calleeName && ["eval", "Function", "require", "setTimeout", "setInterval"].includes(calleeName)) {
			throw new Error(`Workflow call ${calleeName}() is unavailable.`);
		}
	}
	if (node.type === "NewExpression") {
		const calleeName = identifierName(node.callee);
		if (calleeName === "Date" || calleeName === "Function") {
			throw new Error(`Workflow new ${calleeName}() is unavailable.`);
		}
	}
	if (node.type === "MemberExpression") {
		if (node.computed === true && (!isAstNode(node.property) || node.property.type !== "Literal")) {
			throw new Error("Workflow computed property names must be literal values.");
		}
		const propertyName = staticPropertyName(node);
		if (propertyName && RESERVED_PROPERTIES.has(propertyName)) {
			throw new Error(`Workflow property ${propertyName} is unavailable.`);
		}
		const objectName = identifierName(node.object);
		if (propertyName && RESERVED_REFLECTION_PROPERTIES.has(propertyName)) {
			throw new Error(`Workflow ${objectName ? `${objectName}.` : ""}${propertyName}() is unavailable.`);
		}
		if ((objectName === "Date" && propertyName === "now") || (objectName === "Math" && propertyName === "random")) {
			throw new Error(`Workflow ${objectName}.${propertyName}() is nondeterministic.`);
		}
	}
	if (node.type === "Property" && isAstNode(node.key)) {
		if (node.computed === true && node.key.type !== "Literal") {
			throw new Error("Workflow computed property names must be literal values.");
		}
		const key = propertyKey(node.key);
		if (RESERVED_PROPERTIES.has(key)) throw new Error(`Workflow property ${key} is unavailable.`);
	}
	for (const child of childNodes(node)) assertDeterministic(child);
}

function propertyKey(node: AstNode): string {
	const identifier = identifierName(node);
	if (identifier) return identifier;
	if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
		return String(node.value);
	}
	throw new Error("Workflow metadata keys must be static strings.");
}

function evaluateLiteral(node: AstNode, path: string): unknown {
	switch (node.type) {
		case "ObjectExpression": {
			const output: Record<string, unknown> = {};
			const properties = Array.isArray(node.properties) ? node.properties : [];
			for (const property of properties) {
				if (!isAstNode(property) || property.type !== "Property" || property.computed === true) {
					throw new Error(`${path} must contain only plain properties.`);
				}
				if (!isAstNode(property.key) || !isAstNode(property.value)) {
					throw new Error(`${path} contains an invalid property.`);
				}
				const key = propertyKey(property.key);
				if (RESERVED_PROPERTIES.has(key)) throw new Error(`${path}.${key} is reserved.`);
				output[key] = evaluateLiteral(property.value, `${path}.${key}`);
			}
			return output;
		}
		case "ArrayExpression": {
			const elements = Array.isArray(node.elements) ? node.elements : [];
			return elements.map((element, index) => {
				if (!isAstNode(element)) throw new Error(`${path}[${index}] must not be empty.`);
				return evaluateLiteral(element, `${path}[${index}]`);
			});
		}
		case "Literal":
			return node.value;
		case "TemplateLiteral": {
			const expressions = Array.isArray(node.expressions) ? node.expressions : [];
			if (expressions.length > 0) throw new Error(`${path} cannot contain template interpolation.`);
			const quasis = Array.isArray(node.quasis) ? node.quasis : [];
			return quasis
				.map((quasi) => {
					if (!isAstNode(quasi) || !quasi.value || typeof quasi.value !== "object") return "";
					const value = quasi.value as { cooked?: unknown; raw?: unknown };
					return typeof value.cooked === "string" ? value.cooked : String(value.raw ?? "");
				})
				.join("");
		}
		case "UnaryExpression":
			if (node.operator === "-" && isAstNode(node.argument) && typeof node.argument.value === "number") {
				return -node.argument.value;
			}
			throw new Error(`${path} contains a non-literal unary expression.`);
		default:
			throw new Error(`${path} must be literal metadata.`);
	}
}

function validatePermissions(value: unknown): WorkflowPermissions | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("meta.permissions must be an object.");
	}
	const permissions = value as Record<string, unknown>;
	for (const key of Object.keys(permissions)) {
		if (!["network", "write", "destructive"].includes(key) || typeof permissions[key] !== "boolean") {
			throw new Error(`meta.permissions.${key} must be a supported boolean permission.`);
		}
	}
	return permissions as WorkflowPermissions;
}

function validateMeta(value: unknown): WorkflowMeta {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("meta must be an object.");
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(raw.name)) {
		throw new Error("meta.name must be a 2-64 character snake_case identifier.");
	}
	if (typeof raw.description !== "string" || !raw.description.trim()) {
		throw new Error("meta.description must be a non-empty string.");
	}
	if (raw.whenToUse !== undefined && typeof raw.whenToUse !== "string") {
		throw new Error("meta.whenToUse must be a string.");
	}
	let phases: WorkflowMetaPhase[] | undefined;
	if (raw.phases !== undefined) {
		if (!Array.isArray(raw.phases)) throw new Error("meta.phases must be an array.");
		phases = raw.phases.map((phase, index) => {
			if (typeof phase === "string" && phase.trim()) return { title: phase };
			if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
				throw new Error(`meta.phases[${index}] must be an object or a non-empty string.`);
			}
			const item = phase as Record<string, unknown>;
			if (typeof item.title !== "string" || !item.title.trim()) {
				throw new Error(`meta.phases[${index}].title must be a non-empty string.`);
			}
			if (item.detail !== undefined && typeof item.detail !== "string") {
				throw new Error(`meta.phases[${index}].detail must be a string.`);
			}
			return { title: item.title, ...(typeof item.detail === "string" ? { detail: item.detail } : {}) };
		});
	}
	return {
		name: raw.name,
		description: raw.description,
		...(typeof raw.whenToUse === "string" ? { whenToUse: raw.whenToUse } : {}),
		...(phases ? { phases } : {}),
		...(raw.permissions ? { permissions: validatePermissions(raw.permissions) } : {}),
	};
}

function assertNoAdditionalModuleSyntax(statements: readonly AstNode[]): void {
	for (const statement of statements) {
		if (
			statement.type === "ExportNamedDeclaration" ||
			statement.type === "ExportDefaultDeclaration" ||
			statement.type === "ExportAllDeclaration"
		) {
			throw new Error("Only the leading workflow metadata declaration may use export.");
		}
	}
}

function assertExecutableBody(body: string, workflowName: string): void {
	try {
		new vm.Script(`(async () => {\n${body}\n})()`, { filename: `${workflowName}.workflow.js` });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Workflow body is not executable: ${detail}`);
	}
}

export function parseWorkflowScript(script: string): ParsedWorkflow {
	if (!script.trim()) throw new Error("Workflow script is empty.");
	const ast = parse(script, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
	}) as unknown as ProgramNode;
	assertDeterministic(ast);
	const first = ast.body[0];
	if (!first || first.type !== "ExportNamedDeclaration" || !isAstNode(first.declaration)) {
		throw new Error("The first statement must be export const meta = { name, description }.");
	}
	const declaration = first.declaration;
	if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
		throw new Error("Workflow metadata must use export const meta = ...");
	}
	const declarations = Array.isArray(declaration.declarations) ? declaration.declarations : [];
	if (declarations.length !== 1 || !isAstNode(declarations[0])) {
		throw new Error("Workflow metadata must declare only meta.");
	}
	const declarator = declarations[0];
	if (identifierName(declarator.id) !== "meta" || !isAstNode(declarator.init)) {
		throw new Error("Workflow metadata must declare meta with a literal value.");
	}
	const meta = validateMeta(evaluateLiteral(declarator.init, "meta"));
	assertNoAdditionalModuleSyntax(ast.body.slice(1));
	const body = `${script.slice(0, first.start)}${script.slice(first.end)}`;
	assertExecutableBody(body, meta.name);
	return {
		meta,
		body,
	};
}
