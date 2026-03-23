import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

type FileComplexity = {
  filePath: string;
  fileScore: number;
  symbolScore: number;
  worstSymbol: string;
};

const ROOT = process.cwd();
const MAX_SYMBOL_DEFAULT = 30;
const MAX_FILE_DEFAULT = 50;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "output"
]);

const IGNORED_SUFFIXES = [".d.ts"];

function collectTsFiles(dirPath: string, results: string[]): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      collectTsFiles(fullPath, results);
      continue;
    }

    if (!entry.name.endsWith(".ts")) continue;
    if (IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    results.push(fullPath);
  }
}

function isControlFlowNode(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node)
  );
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function complexityFromNode(node: ts.Node): number {
  let score = 1;
  const visit = (current: ts.Node): void => {
    if (isControlFlowNode(current)) {
      score += 1;
    }

    if (ts.isCaseClause(current)) {
      score += 1;
    }

    if (ts.isConditionalExpression(current)) {
      score += 1;
    }

    if (ts.isBinaryExpression(current) && isLogicalOperator(current.operatorToken.kind)) {
      score += 1;
    }

    ts.forEachChild(current, visit);
  };

  ts.forEachChild(node, visit);
  return score;
}

function getNodeLabel(node: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  if (ts.isGetAccessorDeclaration(node)) {
    return "get accessor";
  }

  if (ts.isSetAccessorDeclaration(node)) {
    return "set accessor";
  }

  if (ts.isArrowFunction(node)) {
    return "arrow function";
  }

  if (ts.isFunctionExpression(node)) {
    return "function expression";
  }

  return "<module>";
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function calculateFileComplexity(filePath: string): FileComplexity {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  let worstScore = 1;
  let worstSymbol = "<module>";

  const consider = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) {
      const score = complexityFromNode(node);
      if (score > worstScore) {
        worstScore = score;
        worstSymbol = getNodeLabel(node);
      }
    }

    ts.forEachChild(node, consider);
  };

  consider(sourceFile);

  if (worstSymbol === "<module>") {
    worstScore = complexityFromNode(sourceFile);
  }

  const fileScore = complexityFromNode(sourceFile);

  return {
    filePath,
    fileScore,
    symbolScore: worstScore,
    worstSymbol
  };
}

function getArgValue(argv: string[], index: number, argName: string): { value: number; nextIndex: number } {
  const next = argv[index + 1];
  if (!next) throw new Error(`Missing value for ${argName}`);
  const value = Number.parseInt(next, 10);
  if (Number.isNaN(value)) throw new Error(`Invalid number for ${argName}: ${next}`);
  return { value, nextIndex: index + 1 };
}

function parseArgs(argv: string[]): { maxSymbol: number; maxFile: number; failOnViolation: boolean } {
  let maxSymbol = MAX_SYMBOL_DEFAULT;
  let maxFile = MAX_FILE_DEFAULT;
  let failOnViolation = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    if (arg === "--max") {
      const { value, nextIndex } = getArgValue(argv, i, arg);
      maxSymbol = value;
      i = nextIndex;
    } else if (arg === "--max-symbol") {
      const { value, nextIndex } = getArgValue(argv, i, arg);
      maxSymbol = value;
      i = nextIndex;
    } else if (arg === "--max-file") {
      const { value, nextIndex } = getArgValue(argv, i, arg);
      maxFile = value;
      i = nextIndex;
    } else if (arg === "--fail-on-violation") {
      failOnViolation = true;
    }
  }

  return { maxSymbol, maxFile, failOnViolation };
}

function collectAllFiles(): string[] {
  const files: string[] = [];
  collectTsFiles(path.join(ROOT, "packages"), files);
  collectTsFiles(path.join(ROOT, "workers"), files);
  collectTsFiles(path.join(ROOT, "scripts"), files);
  return files;
}

function calculateComplexities(files: string[]): FileComplexity[] {
  return files
    .map((filePath) => calculateFileComplexity(filePath))
    .sort((a, b) => b.fileScore - a.fileScore || b.symbolScore - a.symbolScore || a.filePath.localeCompare(b.filePath));
}

function findViolations(results: FileComplexity[], maxSymbol: number, maxFile: number): FileComplexity[] {
  return results.filter((entry) => entry.symbolScore > maxSymbol || entry.fileScore > maxFile);
}

function printReport(results: FileComplexity[], maxSymbol: number, maxFile: number): void {
  console.log("Cyclomatic complexity report");
  console.log(`Thresholds: symbol <= ${maxSymbol}, file <= ${maxFile}`);
  console.log("Columns: fileScore symbolScore path [worstSymbol]");
  console.log("---");
  for (const entry of results) {
    const rel = path.relative(ROOT, entry.filePath);
    console.log(
      `${String(entry.fileScore).padStart(3, " ")} ${String(entry.symbolScore).padStart(3, " ")}  ${rel}  [worst: ${entry.worstSymbol}]`
    );
  }
}

function printViolations(violations: FileComplexity[]): void {
  console.error("---");
  console.error(`Found ${violations.length} file(s) above threshold.`);
}

function main(): void {
  const { maxSymbol, maxFile, failOnViolation } = parseArgs(process.argv.slice(2));
  
  const files = collectAllFiles();
  const results = calculateComplexities(files);
  const violations = findViolations(results, maxSymbol, maxFile);

  printReport(results, maxSymbol, maxFile);

  if (violations.length === 0) {
    console.log("---");
    console.log("All files are within threshold.");
    return;
  }

  printViolations(violations);

  if (failOnViolation) {
    process.exitCode = 1;
  }
}

main();
