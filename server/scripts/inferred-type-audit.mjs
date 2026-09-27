import ts from 'typescript';

/** @param {ts.Type} type @returns {type is ts.TypeReference} */
function isTypeReference(type) {
  return (type.flags & ts.TypeFlags.Object) !== 0
    && 'objectFlags' in type && typeof type.objectFlags === 'number'
    && (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

/**
 * Detect unresolved/evolving bindings and unsafe generic defaults, even when a
 * value is unused. ESLint's unsafe-use rules alone do not reject those cases.
 * Inspect type arguments without traversing dependency implementation members.
 * @param {ts.Program} program
 * @param {readonly ts.SourceFile[]} files
 */
export function inferredTypeDiagnostics(program, files) {
  const checker = program.getTypeChecker();
  /** @type {{file: string, line: number, column: number, name: string, type: string}[]} */
  const diagnostics = [];

  /** @param {ts.Type} type @param {Set<ts.Type>} seen @returns {boolean} */
  function containsAny(type, seen) {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.flags & ts.TypeFlags.Any) return true;
    if (type.isUnionOrIntersection() && type.types.some(part => containsAny(part, seen))) return true;
    const arguments_ = isTypeReference(type) ? checker.getTypeArguments(type) : type.aliasTypeArguments ?? [];
    return arguments_.some(argument => containsAny(argument, seen));
  }

  for (const file of files) {
    /** @param {ts.Node} node */
    function visit(node) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isBindingElement(node) || ts.isPropertyDeclaration(node)
        || ts.isPropertyAssignment(node) || ts.isPropertySignature(node)
        || ts.isTypeAliasDeclaration(node))
        && ts.isIdentifier(node.name)) {
        const type = checker.getTypeAtLocation(node.name);
        if (containsAny(type, new Set())) {
          const position = file.getLineAndCharacterOfPosition(node.name.getStart(file));
          diagnostics.push({ file: file.fileName, line: position.line + 1,
            column: position.character + 1, name: node.name.text, type: checker.typeToString(type) });
        }
      }
      if (ts.isFunctionLike(node)) {
        const signature = checker.getSignatureFromDeclaration(node);
        const type = signature && checker.getReturnTypeOfSignature(signature);
        if (type && containsAny(type, new Set())) {
          const position = file.getLineAndCharacterOfPosition(node.getStart(file));
          diagnostics.push({ file: file.fileName, line: position.line + 1,
            column: position.character + 1, name: `${node.name?.getText(file) ?? '<function>'} return`,
            type: checker.typeToString(type) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return diagnostics;
}
