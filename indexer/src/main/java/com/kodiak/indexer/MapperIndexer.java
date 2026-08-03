package com.kodiak.indexer;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.VariableDeclarationExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.ExpressionStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.kodiak.indexer.model.AstStep;
import com.kodiak.indexer.model.IndexResult;
import com.kodiak.indexer.registry.MapperEntry;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Deterministic JavaParser walk of a mapper entry method into AST steps.
 * Unrecognized shapes become RAW — never guessed.
 * Same-class private helpers are inlined; literals/static finals become CONSTANT
 * with Java-FQN target/source fields.
 */
public class MapperIndexer {

  private CompilationUnit unit;
  private String mapperClassFqcn;
  private String packageName;

  public IndexResult index(MapperEntry entry, Path sourceRoot) {
    Path sourceFile = sourceRoot.resolve(entry.getSourceFile());
    try {
      unit = StaticJavaParser.parse(sourceFile);
    } catch (IOException e) {
      throw new IndexingException("Failed to read source file: " + sourceFile, e);
    }

    packageName =
        unit.getPackageDeclaration().map(p -> p.getNameAsString()).orElse("");
    mapperClassFqcn = entry.getClassName();

    String simpleClassName = simpleName(entry.getClassName());
    ClassOrInterfaceDeclaration classDecl =
        unit.getClassByName(simpleClassName)
            .orElseThrow(
                () ->
                    new IndexingException(
                        "Class " + simpleClassName + " not found in " + sourceFile, null));

    MethodDeclaration entryMethod = findMethod(classDecl, entry.getEntryMethod());

    IndexResult result = new IndexResult();
    result.setMapperId(entry.getId());
    result.setClassName(entry.getClassName());
    result.setEntryMethod(entry.getEntryMethod());
    result.setSourceType(entry.getSourceType());
    result.setTargetType(entry.getTargetType());
    result.setSourceFile(entry.getSourceFile());

    Set<String> visited = new HashSet<>();
    visited.add(entry.getEntryMethod());

    Map<String, String> locals = new HashMap<>();
    bindParameters(entryMethod, locals);

    result
        .getSteps()
        .addAll(
            indexBlock(
                classDecl,
                entryMethod.getBody().orElse(new BlockStmt()),
                visited,
                locals,
                false));
    return result;
  }

  private void bindParameters(MethodDeclaration method, Map<String, String> locals) {
    for (Parameter param : method.getParameters()) {
      locals.put(param.getNameAsString(), resolveTypeFqcn(param.getType().asString()));
    }
  }

  private List<AstStep> indexBlock(
      ClassOrInterfaceDeclaration classDecl,
      BlockStmt block,
      Set<String> visited,
      Map<String, String> locals,
      boolean inlining) {
    List<AstStep> steps = new ArrayList<>();
    for (Statement stmt : block.getStatements()) {
      steps.addAll(classify(classDecl, stmt, visited, locals, inlining));
    }
    return steps;
  }

  private List<AstStep> indexStatement(
      ClassOrInterfaceDeclaration classDecl,
      Statement stmt,
      Set<String> visited,
      Map<String, String> locals,
      boolean inlining) {
    if (stmt.isBlockStmt()) {
      return indexBlock(classDecl, stmt.asBlockStmt(), visited, locals, inlining);
    }
    return classify(classDecl, stmt, visited, locals, inlining);
  }

  private List<AstStep> classify(
      ClassOrInterfaceDeclaration classDecl,
      Statement stmt,
      Set<String> visited,
      Map<String, String> locals,
      boolean inlining) {
    if (stmt.isReturnStmt()) {
      if (inlining) {
        return List.of();
      }
      ReturnStmt ret = stmt.asReturnStmt();
      return ret.getExpression()
          .map(expr -> List.of(AstStep.write("<return>", expr.toString(), stmt.toString())))
          .orElse(List.of(AstStep.raw(stmt.toString())));
    }

    if (stmt.isIfStmt()) {
      IfStmt ifStmt = stmt.asIfStmt();
      Map<String, String> branchLocals = new HashMap<>(locals);
      List<AstStep> thenSteps =
          indexStatement(
              classDecl,
              ifStmt.getThenStmt(),
              new HashSet<>(visited),
              branchLocals,
              inlining);
      return List.of(
          AstStep.filter(ifStmt.getCondition().toString(), thenSteps, stmt.toString()));
    }

    if (stmt.isExpressionStmt()) {
      ExpressionStmt exprStmt = stmt.asExpressionStmt();
      Expression expr = exprStmt.getExpression();

      if (expr.isAssignExpr()) {
        return List.of(AstStep.raw(stmt.toString()));
      }

      if (expr.isMethodCallExpr()) {
        MethodCallExpr call = expr.asMethodCallExpr();
        Optional<List<AstStep>> inlined =
            tryInlineHelper(classDecl, call, visited, locals, stmt.toString());
        if (inlined.isPresent()) {
          return inlined.get();
        }
        if (call.getNameAsString().startsWith("set") && call.getArguments().size() == 1) {
          return classifySetter(classDecl, call, visited, locals, stmt.toString());
        }
      }

      if (expr.isVariableDeclarationExpr()) {
        VariableDeclarationExpr varDecl = expr.asVariableDeclarationExpr();
        List<AstStep> steps = new ArrayList<>();
        for (VariableDeclarator var : varDecl.getVariables()) {
          recordLocalType(var, locals);
          if (var.getInitializer().isEmpty()) {
            continue;
          }
          Expression init = var.getInitializer().get();
          String buildTarget = buildTargetPath(var.getNameAsString(), locals);
          if (init.isMethodCallExpr()) {
            MethodCallExpr initCall = init.asMethodCallExpr();
            Optional<List<AstStep>> inlined =
                tryInlineHelper(classDecl, initCall, visited, locals, stmt.toString());
            if (inlined.isPresent()) {
              steps.addAll(inlined.get());
              continue;
            }
            steps.add(AstStep.build(buildTarget, init.toString(), stmt.toString()));
            continue;
          }
          if (init.isObjectCreationExpr()) {
            ObjectCreationExpr created = init.asObjectCreationExpr();
            steps.add(AstStep.build(buildTarget, created.toString(), stmt.toString()));
            continue;
          }
          steps.add(AstStep.raw(stmt.toString()));
        }
        if (!steps.isEmpty()) {
          return steps;
        }
      }
    }

    return List.of(AstStep.raw(stmt.toString()));
  }

  private void recordLocalType(VariableDeclarator var, Map<String, String> locals) {
    String typeName = var.getType().asString();
    if (var.getInitializer().isPresent() && var.getInitializer().get().isObjectCreationExpr()) {
      typeName = var.getInitializer().get().asObjectCreationExpr().getType().asString();
    }
    locals.put(var.getNameAsString(), resolveTypeFqcn(typeName));
  }

  /** setFoo(arg) → CONSTANT when arg is literal/static final; else WRITE. Helpers flatten in. */
  private List<AstStep> classifySetter(
      ClassOrInterfaceDeclaration classDecl,
      MethodCallExpr call,
      Set<String> visited,
      Map<String, String> locals,
      String sourceText) {
    String leafField = setterFieldName(call.getNameAsString());
    Expression arg = call.getArgument(0);

    if (arg.isMethodCallExpr()) {
      MethodCallExpr argCall = arg.asMethodCallExpr();
      Optional<List<AstStep>> inlined =
          tryInlineHelper(classDecl, argCall, visited, locals, sourceText);
      if (inlined.isPresent()) {
        return inlined.get();
      }
    }

    String targetPath = qualifyTargetField(call, locals, leafField);
    String constantValue = resolveConstantValue(classDecl, arg);
    if (constantValue != null) {
      return List.of(AstStep.constant(targetPath, constantValue));
    }

    return List.of(AstStep.write(targetPath, arg.toString(), sourceText));
  }

  /** BUILD target: type-relative path when known, else local var name. */
  private String buildTargetPath(String varName, Map<String, String> locals) {
    String typeFqcn = locals.get(varName);
    if (typeFqcn != null && !typeFqcn.isBlank()) {
      return typePathFromSimpleClass(typeFqcn);
    }
    return varName;
  }

  private String qualifyTargetField(
      MethodCallExpr call, Map<String, String> locals, String leafField) {
    String receiverType = resolveReceiverType(call, locals);
    if (receiverType != null && !receiverType.isBlank()) {
      // Package is already on pipeline targetType/sourceType — keep from OuterClass onward
      return typePathFromSimpleClass(receiverType) + "." + leafField;
    }
    return leafField;
  }

  /**
   * {@code com.pkg.Outer.Inner} → {@code Outer.Inner} (drop package; keep nested types).
   */
  static String typePathFromSimpleClass(String fqcn) {
    if (fqcn == null || fqcn.isBlank()) {
      return fqcn;
    }
    String[] parts = fqcn.split("\\.");
    for (int i = 0; i < parts.length; i++) {
      if (!parts[i].isEmpty() && Character.isUpperCase(parts[i].charAt(0))) {
        StringBuilder sb = new StringBuilder(parts[i]);
        for (int j = i + 1; j < parts.length; j++) {
          sb.append('.').append(parts[j]);
        }
        return sb.toString();
      }
    }
    return fqcn;
  }

  private String resolveReceiverType(MethodCallExpr call, Map<String, String> locals) {
    if (call.getScope().isEmpty()) {
      return null;
    }
    Expression scope = call.getScope().get();
    if (scope.isNameExpr()) {
      return locals.get(scope.asNameExpr().getNameAsString());
    }
    return null;
  }

  private Optional<List<AstStep>> tryInlineHelper(
      ClassOrInterfaceDeclaration classDecl,
      MethodCallExpr call,
      Set<String> visited,
      Map<String, String> parentLocals,
      String sourceText) {
    if (!isSameClassHelperCall(classDecl, call)) {
      return Optional.empty();
    }
    String name = call.getNameAsString();
    if (visited.contains(name)) {
      return Optional.empty();
    }
    MethodDeclaration helper =
        classDecl.getMethodsByName(name).stream().findFirst().orElse(null);
    if (helper == null || helper.getBody().isEmpty()) {
      return Optional.empty();
    }
    Set<String> nextVisited = new HashSet<>(visited);
    nextVisited.add(name);

    Map<String, String> helperLocals = new HashMap<>();
    List<Parameter> params = helper.getParameters();
    for (int i = 0; i < params.size(); i++) {
      Parameter param = params.get(i);
      String typeFqcn = resolveTypeFqcn(param.getType().asString());
      if (i < call.getArguments().size() && call.getArgument(i).isNameExpr()) {
        String argName = call.getArgument(i).asNameExpr().getNameAsString();
        if (parentLocals.containsKey(argName)) {
          typeFqcn = parentLocals.get(argName);
        }
      }
      helperLocals.put(param.getNameAsString(), typeFqcn);
    }

    List<AstStep> inlined =
        indexBlock(classDecl, helper.getBody().get(), nextVisited, helperLocals, true);
    if (inlined.isEmpty()) {
      return Optional.of(List.of(AstStep.build(name, call.toString(), sourceText)));
    }
    return Optional.of(inlined);
  }

  /**
   * Same-class helper: unqualified call (or this.foo) whose name matches a method on this class.
   * Excludes setters handled separately.
   */
  private boolean isSameClassHelperCall(
      ClassOrInterfaceDeclaration classDecl, MethodCallExpr call) {
    String name = call.getNameAsString();
    if (name.startsWith("set") && call.getArguments().size() == 1) {
      return false;
    }
    boolean scopeOk =
        call.getScope().isEmpty() || call.getScope().get().isThisExpr();
    if (!scopeOk) {
      return false;
    }
    return classDecl.getMethodsByName(name).stream().findFirst().isPresent();
  }

  /** Resolve a simple/qualified type name to a binary Java FQN (nested types use {@code $}). */
  private String resolveTypeFqcn(String typeName) {
    if (typeName == null || typeName.isBlank()) {
      return typeName;
    }
    // Strip generics
    int generic = typeName.indexOf('<');
    if (generic >= 0) {
      typeName = typeName.substring(0, generic).trim();
    }

    String simple = typeName.contains(".")
        ? typeName.substring(typeName.lastIndexOf('.') + 1)
        : typeName;

    for (ImportDeclaration imp : unit.getImports()) {
      if (imp.isAsterisk() || imp.isStatic()) {
        continue;
      }
      String imported = imp.getNameAsString();
      if (imported.equals(typeName)
          || imported.endsWith("." + typeName)
          || (typeName.equals(simple) && imported.endsWith("." + simple))) {
        return importToBinaryName(imported);
      }
    }

    // Nested type on mapper class itself
    if (unit.getClassByName(simpleName(mapperClassFqcn)).isPresent()) {
      ClassOrInterfaceDeclaration mapper =
          unit.getClassByName(simpleName(mapperClassFqcn)).get();
      if (mapper.getMembers().stream()
          .filter(ClassOrInterfaceDeclaration.class::isInstance)
          .map(ClassOrInterfaceDeclaration.class::cast)
          .anyMatch(c -> c.getNameAsString().equals(simple))) {
        return mapperClassFqcn + "." + simple;
      }
    }

    // Same-package fallback
    if (!typeName.contains(".")) {
      return packageName.isEmpty() ? typeName : packageName + "." + typeName;
    }

    // Already looks qualified — convert nested dots after first Class segment
    return importToBinaryName(typeName);
  }

  /** Keep dotted source-style paths for nested types ({@code Outer.Inner}, not {@code Outer$Inner}). */
  static String importToBinaryName(String name) {
    return name;
  }

  private String resolveConstantValue(ClassOrInterfaceDeclaration classDecl, Expression expr) {
    if (expr.isStringLiteralExpr()) {
      return expr.asStringLiteralExpr().asString();
    }
    if (expr.isIntegerLiteralExpr()) {
      return expr.asIntegerLiteralExpr().getValue();
    }
    if (expr.isLongLiteralExpr()) {
      return expr.asLongLiteralExpr().getValue();
    }
    if (expr.isDoubleLiteralExpr()) {
      return expr.asDoubleLiteralExpr().getValue();
    }
    if (expr.isBooleanLiteralExpr()) {
      return Boolean.toString(expr.asBooleanLiteralExpr().getValue());
    }
    if (expr.isNullLiteralExpr()) {
      return "null";
    }
    if (expr.isNameExpr()) {
      String name = expr.asNameExpr().getNameAsString();
      for (FieldDeclaration field : classDecl.getFields()) {
        if (!field.isStatic() || !field.isFinal()) {
          continue;
        }
        for (VariableDeclarator variable : field.getVariables()) {
          if (!variable.getNameAsString().equals(name) || variable.getInitializer().isEmpty()) {
            continue;
          }
          Expression init = variable.getInitializer().get();
          if (init.isStringLiteralExpr()) {
            return init.asStringLiteralExpr().asString();
          }
          if (init.isIntegerLiteralExpr()) {
            return init.asIntegerLiteralExpr().getValue();
          }
          if (init.isLongLiteralExpr()) {
            return init.asLongLiteralExpr().getValue();
          }
          if (init.isDoubleLiteralExpr()) {
            return init.asDoubleLiteralExpr().getValue();
          }
          if (init.isBooleanLiteralExpr()) {
            return Boolean.toString(init.asBooleanLiteralExpr().getValue());
          }
        }
      }
    }
    return null;
  }

  private String setterFieldName(String setterName) {
    String targetField = setterName.substring(3);
    return Character.toLowerCase(targetField.charAt(0)) + targetField.substring(1);
  }

  private MethodDeclaration findMethod(ClassOrInterfaceDeclaration classDecl, String name) {
    return classDecl.getMethodsByName(name).stream()
        .findFirst()
        .orElseThrow(
            () ->
                new IndexingException(
                    "Method " + name + " not found in " + classDecl.getName(), null));
  }

  private String simpleName(String fqcn) {
    int dollar = fqcn.lastIndexOf('$');
    int dot = fqcn.lastIndexOf('.');
    int idx = Math.max(dollar, dot);
    return idx >= 0 ? fqcn.substring(idx + 1) : fqcn;
  }

  public static class IndexingException extends RuntimeException {
    public IndexingException(String message, Throwable cause) {
      super(message, cause);
    }
  }
}
