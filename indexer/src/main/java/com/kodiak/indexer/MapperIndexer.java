package com.kodiak.indexer;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.ArrayAccessExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
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
 *
 * <p>Tracks containment paths so nested targets look like {@code Outer.Mid.Leaf.field}. Direct
 * getter→setter mappings become READ with path source/target (no sourceText). Literals/static
 * finals become CONSTANT.
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
    Map<String, String> varPaths = new HashMap<>();
    Map<String, Expression> varInits = new HashMap<>();
    bindParameters(entryMethod, locals, varPaths);

    result
        .getOperations()
        .addAll(
            indexBlock(
                classDecl,
                entryMethod.getBody().orElse(new BlockStmt()),
                visited,
                locals,
                varPaths,
                varInits,
                null,
                false));
    return result;
  }

  private void bindParameters(
      MethodDeclaration method, Map<String, String> locals, Map<String, String> varPaths) {
    for (Parameter param : method.getParameters()) {
      String typeFqcn = resolveTypeFqcn(param.getType().asString());
      locals.put(param.getNameAsString(), typeFqcn);
      varPaths.put(param.getNameAsString(), typePathFromSimpleClass(typeFqcn));
    }
  }

  private List<AstStep> indexBlock(
      ClassOrInterfaceDeclaration classDecl,
      BlockStmt block,
      Set<String> visited,
      Map<String, String> locals,
      Map<String, String> varPaths,
      Map<String, Expression> varInits,
      String nestRoot,
      boolean inlining) {
    List<AstStep> steps = new ArrayList<>();
    for (Statement stmt : block.getStatements()) {
      steps.addAll(
          classify(classDecl, stmt, visited, locals, varPaths, varInits, nestRoot, inlining));
    }
    return steps;
  }

  private List<AstStep> indexStatement(
      ClassOrInterfaceDeclaration classDecl,
      Statement stmt,
      Set<String> visited,
      Map<String, String> locals,
      Map<String, String> varPaths,
      Map<String, Expression> varInits,
      String nestRoot,
      boolean inlining) {
    if (stmt.isBlockStmt()) {
      return indexBlock(
          classDecl, stmt.asBlockStmt(), visited, locals, varPaths, varInits, nestRoot, inlining);
    }
    return classify(classDecl, stmt, visited, locals, varPaths, varInits, nestRoot, inlining);
  }

  private List<AstStep> classify(
      ClassOrInterfaceDeclaration classDecl,
      Statement stmt,
      Set<String> visited,
      Map<String, String> locals,
      Map<String, String> varPaths,
      Map<String, Expression> varInits,
      String nestRoot,
      boolean inlining) {
    if (stmt.isReturnStmt()) {
      if (inlining) {
        return List.of();
      }
      ReturnStmt ret = stmt.asReturnStmt();
      return ret.getExpression()
          .map(expr -> List.of(AstStep.write("<return>", expr.toString())))
          .orElse(List.of(AstStep.raw(stmt.toString())));
    }

    if (stmt.isIfStmt()) {
      IfStmt ifStmt = stmt.asIfStmt();
      Map<String, String> branchLocals = new HashMap<>(locals);
      Map<String, String> branchPaths = new HashMap<>(varPaths);
      Map<String, Expression> branchInits = new HashMap<>(varInits);
      List<AstStep> thenOps =
          indexStatement(
              classDecl,
              ifStmt.getThenStmt(),
              new HashSet<>(visited),
              branchLocals,
              branchPaths,
              branchInits,
              nestRoot,
              inlining);
      // Null guards (x != null / x == null) are implicit — flatten, do not emit FILTER
      if (isNullGuard(ifStmt.getCondition())) {
        return thenOps;
      }
      // Flat pipeline: FILTER marker then then-branch ops (no children)
      List<AstStep> flat = new ArrayList<>();
      flat.add(AstStep.filter(ifStmt.getCondition().toString()));
      flat.addAll(thenOps);
      return flat;
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
            tryInlineHelper(
                classDecl, call, visited, locals, varPaths, varInits, null, stmt.toString());
        if (inlined.isPresent()) {
          return inlined.get();
        }
        if (call.getNameAsString().startsWith("set") && call.getArguments().size() == 1) {
          return classifySetter(
              classDecl, call, visited, locals, varPaths, varInits, stmt.toString());
        }
      }

      if (expr.isVariableDeclarationExpr()) {
        VariableDeclarationExpr varDecl = expr.asVariableDeclarationExpr();
        List<AstStep> steps = new ArrayList<>();
        for (VariableDeclarator var : varDecl.getVariables()) {
          if (var.getInitializer().isEmpty()) {
            recordLocal(var, null, locals, varPaths, nestRoot);
            continue;
          }
          Expression init = var.getInitializer().get();
          recordLocal(var, init, locals, varPaths, nestRoot);
          varInits.put(var.getNameAsString(), init);
          String buildTarget = varPaths.getOrDefault(var.getNameAsString(), var.getNameAsString());

          if (init.isMethodCallExpr()) {
            MethodCallExpr initCall = init.asMethodCallExpr();
            Optional<List<AstStep>> inlined =
                tryInlineHelper(
                    classDecl, initCall, visited, locals, varPaths, varInits, null, stmt.toString());
            if (inlined.isPresent()) {
              steps.addAll(inlined.get());
              continue;
            }
            // Getter/init into a local — not a target BUILD object
            if (resolveSourceFieldPath(init, locals, varPaths) != null) {
              continue;
            }
            // Intermediate compute locals (splitName → String[], etc.) — track only for later RAW
            if (isIntermediateLocalType(var.getType().asString())
                || (isSameClassHelperCall(classDecl, initCall)
                    && !isInlinableReturnType(initCall, classDecl))) {
              continue;
            }
            steps.add(AstStep.build(buildTarget, init.toString()));
            continue;
          }
          if (init.isObjectCreationExpr()) {
            ObjectCreationExpr created = init.asObjectCreationExpr();
            steps.add(AstStep.build(buildTarget, created.toString()));
            continue;
          }
          steps.add(AstStep.raw(stmt.toString()));
        }
        if (!steps.isEmpty()) {
          return steps;
        }
        return List.of();
      }
    }

    return List.of(AstStep.raw(stmt.toString()));
  }

  private void recordLocal(
      VariableDeclarator var,
      Expression init,
      Map<String, String> locals,
      Map<String, String> varPaths,
      String nestRoot) {
    String typeName = var.getType().asString();
    if (init != null && init.isObjectCreationExpr()) {
      typeName = init.asObjectCreationExpr().getType().asString();
    }
    String typeFqcn = resolveTypeFqcn(typeName);
    locals.put(var.getNameAsString(), typeFqcn);

    String typePath = typePathFromSimpleClass(typeFqcn);
    String simple = simpleName(typePath);

    if (init != null) {
      String sourcePath = resolveSourceFieldPath(init, locals, varPaths);
      if (sourcePath != null) {
        varPaths.put(var.getNameAsString(), sourcePath);
        return;
      }
    }

    if (nestRoot != null && (nestRoot.equals(simple) || nestRoot.endsWith("." + simple))) {
      varPaths.put(var.getNameAsString(), nestRoot);
      return;
    }

    varPaths.put(var.getNameAsString(), typePath);
  }

  /**
   * setFoo(arg) → CONSTANT / READ (path mapping) / WRITE. Helpers flatten in with nest path.
   * Array-index or scalar String helpers (e.g. parts[0] / Optional.trim) → RAW for labeling.
   */
  private List<AstStep> classifySetter(
      ClassOrInterfaceDeclaration classDecl,
      MethodCallExpr call,
      Set<String> visited,
      Map<String, String> locals,
      Map<String, String> varPaths,
      Map<String, Expression> varInits,
      String sourceText) {
    String leafField = accessorFieldName(call.getNameAsString(), "set");
    Expression arg = call.getArgument(0);

    if (arg.isMethodCallExpr()) {
      MethodCallExpr argCall = arg.asMethodCallExpr();
      String nestRoot = nestRootForSetterArg(call, argCall, classDecl, locals, varPaths);
      Optional<List<AstStep>> inlined =
          tryInlineHelper(
              classDecl, argCall, visited, locals, varPaths, varInits, nestRoot, sourceText);
      if (inlined.isPresent()) {
        return inlined.get();
      }
    }

    String targetPath = qualifyTargetField(call, locals, varPaths, leafField);

    if (arg.isArrayAccessExpr()) {
      return List.of(
          rawForArrayDerivedSetter(
              classDecl,
              arg.asArrayAccessExpr(),
              targetPath,
              locals,
              varPaths,
              varInits,
              sourceText));
    }

    // Scalar helpers (String/Optional.trim/etc.): not inlined — bundle body as RAW for AI.
    if (arg.isMethodCallExpr()) {
      MethodCallExpr argCall = arg.asMethodCallExpr();
      if (isSameClassHelperCall(classDecl, argCall)
          && !isInlinableReturnType(argCall, classDecl)) {
        return List.of(
            rawForHelperDerivedSetter(
                classDecl, argCall, targetPath, locals, varPaths, sourceText));
      }
    }

    String constantValue = resolveConstantValue(classDecl, arg);
    if (constantValue != null) {
      return List.of(AstStep.constant(targetPath, constantValue));
    }

    List<AstStep> arithmetic = classifyArithmeticSetter(arg, targetPath, locals, varPaths);
    if (arithmetic != null) {
      return arithmetic;
    }

    String sourcePath = resolveSourceFieldPath(arg, locals, varPaths);
    if (sourcePath != null) {
      return List.of(AstStep.read(targetPath, sourcePath));
    }

    return List.of(AstStep.write(targetPath, arg.toString()));
  }

  /**
   * Bundle setter + scalar helper body so Gemini can label read/trim/filter pipelines.
   * e.g. {@code setStreetLine(mapStreetViaOptional(address))}
   */
  private AstStep rawForHelperDerivedSetter(
      ClassOrInterfaceDeclaration classDecl,
      MethodCallExpr helperCall,
      String targetPath,
      Map<String, String> locals,
      Map<String, String> varPaths,
      String setterText) {
    StringBuilder code = new StringBuilder();
    for (Expression helperArg : helperCall.getArguments()) {
      String hint = resolveSourceFieldPath(helperArg, locals, varPaths);
      if (hint != null) {
        code.append("// sourceField: ").append(hint).append("\n");
        break;
      }
    }
    code.append(setterText);
    MethodDeclaration helper =
        classDecl.getMethodsByName(helperCall.getNameAsString()).stream()
            .findFirst()
            .orElse(null);
    if (helper != null) {
      code.append("\n\n").append(helper);
    }
    return AstStep.raw(code.toString(), targetPath);
  }

  /**
   * Bundle assignment + setter + helper body so Gemini can label read/split/take/trim pipelines.
   */
  private AstStep rawForArrayDerivedSetter(
      ClassOrInterfaceDeclaration classDecl,
      ArrayAccessExpr access,
      String targetPath,
      Map<String, String> locals,
      Map<String, String> varPaths,
      Map<String, Expression> varInits,
      String setterText) {
    StringBuilder code = new StringBuilder();
    if (access.getName().isNameExpr()) {
      String arr = access.getName().asNameExpr().getNameAsString();
      Expression init = varInits.get(arr);
      if (init != null && init.isMethodCallExpr()) {
        MethodCallExpr initCall = init.asMethodCallExpr();
        if (!initCall.getArguments().isEmpty()) {
          String hint =
              resolveSourceFieldPath(initCall.getArgument(0), locals, varPaths);
          if (hint != null) {
            code.append("// sourceField: ").append(hint).append("\n");
          }
        }
      }
      if (init != null) {
        code.append(arr).append(" = ").append(init).append(";\n");
      }
      code.append(setterText);
      if (init != null && init.isMethodCallExpr()) {
        MethodCallExpr initCall = init.asMethodCallExpr();
        if (isSameClassHelperCall(classDecl, initCall)) {
          MethodDeclaration helper =
              classDecl.getMethodsByName(initCall.getNameAsString()).stream()
                  .findFirst()
                  .orElse(null);
          if (helper != null) {
            code.append("\n\n").append(helper);
          }
        }
      }
    } else {
      code.append(setterText);
    }
    return AstStep.raw(code.toString(), targetPath);
  }

  /**
   * {@code setX(fieldExpr * 12)} → READ source path + TRANSFORM multiply (editable constant).
   * Same for + - /. Generic — any mapper.
   */
  private List<AstStep> classifyArithmeticSetter(
      Expression arg,
      String targetPath,
      Map<String, String> locals,
      Map<String, String> varPaths) {
    if (!arg.isBinaryExpr()) {
      return null;
    }
    BinaryExpr bin = arg.asBinaryExpr();
    String op = arithmeticOp(bin.getOperator());
    if (op == null) {
      return null;
    }
    Expression left = bin.getLeft();
    Expression right = bin.getRight();
    String literal = literalToString(right);
    Expression fieldExpr = left;
    if (literal == null) {
      literal = literalToString(left);
      fieldExpr = right;
    }
    if (literal == null) {
      return null;
    }
    String sourcePath = resolveSourceFieldPath(fieldExpr, locals, varPaths);
    if (sourcePath == null) {
      return null;
    }
    return List.of(
        AstStep.read(targetPath, sourcePath), AstStep.transform(op, literal, targetPath));
  }

  private String arithmeticOp(BinaryExpr.Operator operator) {
    return switch (operator) {
      case MULTIPLY -> "multiply";
      case PLUS -> "add";
      case MINUS -> "subtract";
      case DIVIDE -> "divide";
      default -> null;
    };
  }

  private String literalToString(Expression expr) {
    if (expr.isIntegerLiteralExpr()) {
      return expr.asIntegerLiteralExpr().getValue();
    }
    if (expr.isLongLiteralExpr()) {
      return expr.asLongLiteralExpr().getValue();
    }
    if (expr.isDoubleLiteralExpr()) {
      return expr.asDoubleLiteralExpr().getValue();
    }
    if (expr.isStringLiteralExpr()) {
      return expr.asStringLiteralExpr().asString();
    }
    return null;
  }

  /** When setChild(buildChild()), nest root = receiverPath.ChildType. */
  private String nestRootForSetterArg(
      MethodCallExpr setterCall,
      MethodCallExpr argCall,
      ClassOrInterfaceDeclaration classDecl,
      Map<String, String> locals,
      Map<String, String> varPaths) {
    if (!isSameClassHelperCall(classDecl, argCall)) {
      return null;
    }
    String receiverPath = receiverPath(setterCall, locals, varPaths);
    if (receiverPath == null) {
      return null;
    }
    MethodDeclaration helper =
        classDecl.getMethodsByName(argCall.getNameAsString()).stream().findFirst().orElse(null);
    if (helper == null) {
      return null;
    }
    String returnType = resolveTypeFqcn(helper.getType().asString());
    String childSimple = simpleName(typePathFromSimpleClass(returnType));
    if (childSimple == null || childSimple.isBlank() || childSimple.equals("void")) {
      return null;
    }
    return receiverPath + "." + childSimple;
  }

  private String qualifyTargetField(
      MethodCallExpr call,
      Map<String, String> locals,
      Map<String, String> varPaths,
      String leafField) {
    String path = receiverPath(call, locals, varPaths);
    if (path != null && !path.isBlank()) {
      return path + "." + leafField;
    }
    return leafField;
  }

  private String receiverPath(
      MethodCallExpr call, Map<String, String> locals, Map<String, String> varPaths) {
    if (call.getScope().isEmpty()) {
      return null;
    }
    Expression scope = call.getScope().get();
    if (!scope.isNameExpr()) {
      return null;
    }
    String name = scope.asNameExpr().getNameAsString();
    if (varPaths.containsKey(name)) {
      return varPaths.get(name);
    }
    String type = locals.get(name);
    if (type != null) {
      return typePathFromSimpleClass(type);
    }
    return null;
  }

  /**
   * Resolve {@code input.getCustomerId()} / chained getters to {@code Customer.customerId}.
   */
  private String resolveSourceFieldPath(
      Expression expr, Map<String, String> locals, Map<String, String> varPaths) {
    if (!expr.isMethodCallExpr()) {
      return null;
    }
    MethodCallExpr call = expr.asMethodCallExpr();
    if (!call.getArguments().isEmpty()) {
      return null;
    }
    String accessor = call.getNameAsString();
    String field = accessorFieldName(accessor, null);
    if (field == null) {
      return null;
    }
    if (call.getScope().isEmpty()) {
      return null;
    }
    Expression scope = call.getScope().get();
    if (scope.isNameExpr()) {
      String var = scope.asNameExpr().getNameAsString();
      String base = varPaths.get(var);
      if (base == null && locals.containsKey(var)) {
        base = typePathFromSimpleClass(locals.get(var));
      }
      if (base == null) {
        return null;
      }
      return base + "." + field;
    }
    if (scope.isMethodCallExpr()) {
      String parent = resolveSourceFieldPath(scope, locals, varPaths);
      if (parent == null) {
        return null;
      }
      return parent + "." + field;
    }
    return null;
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

  private Optional<List<AstStep>> tryInlineHelper(
      ClassOrInterfaceDeclaration classDecl,
      MethodCallExpr call,
      Set<String> visited,
      Map<String, String> parentLocals,
      Map<String, String> parentPaths,
      Map<String, Expression> parentInits,
      String nestRoot,
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
    // Only inline DTO builders — String/scalar helpers become RAW via classifySetter
    if (!isInlinableReturnType(helper.getType().asString())) {
      return Optional.empty();
    }
    Set<String> nextVisited = new HashSet<>(visited);
    nextVisited.add(name);

    Map<String, String> helperLocals = new HashMap<>();
    Map<String, String> helperPaths = new HashMap<>();
    Map<String, Expression> helperInits = new HashMap<>();
    List<Parameter> params = helper.getParameters();
    for (int i = 0; i < params.size(); i++) {
      Parameter param = params.get(i);
      String typeFqcn = resolveTypeFqcn(param.getType().asString());
      String path = typePathFromSimpleClass(typeFqcn);
      if (i < call.getArguments().size()) {
        Expression argExpr = call.getArgument(i);
        if (argExpr.isNameExpr()) {
          String argName = argExpr.asNameExpr().getNameAsString();
          if (parentLocals.containsKey(argName)) {
            typeFqcn = parentLocals.get(argName);
          }
          if (parentPaths.containsKey(argName)) {
            path = parentPaths.get(argName);
          } else {
            path = typePathFromSimpleClass(typeFqcn);
          }
        } else {
          String fromGetter = resolveSourceFieldPath(argExpr, parentLocals, parentPaths);
          if (fromGetter != null) {
            path = fromGetter;
          }
        }
      }
      helperLocals.put(param.getNameAsString(), typeFqcn);
      helperPaths.put(param.getNameAsString(), path);
    }

    List<AstStep> inlined =
        indexBlock(
            classDecl,
            helper.getBody().get(),
            nextVisited,
            helperLocals,
            helperPaths,
            helperInits,
            nestRoot,
            true);
    if (inlined.isEmpty()) {
      return Optional.of(List.of(AstStep.build(name, call.toString())));
    }
    return Optional.of(inlined);
  }

  /** True for custom DTO/object return types that should be inlined as nested mappings. */
  private boolean isInlinableReturnType(String typeAsString) {
    if (typeAsString == null || typeAsString.isBlank()) {
      return false;
    }
    String t = typeAsString;
    int generic = t.indexOf('<');
    if (generic >= 0) {
      t = t.substring(0, generic).trim();
    }
    if (t.endsWith("[]")) {
      return false;
    }
    String simple = simpleName(resolveTypeFqcn(t));
    if (simple == null || simple.isBlank()) {
      return false;
    }
    return switch (simple) {
      case "String",
          "Integer",
          "Long",
          "Double",
          "Float",
          "Boolean",
          "Byte",
          "Short",
          "Character",
          "Object",
          "void",
          "int",
          "long",
          "double",
          "float",
          "boolean",
          "byte",
          "short",
          "char" -> false;
      default -> true;
    };
  }

  private boolean isInlinableReturnType(
      MethodCallExpr call, ClassOrInterfaceDeclaration classDecl) {
    MethodDeclaration helper =
        classDecl.getMethodsByName(call.getNameAsString()).stream().findFirst().orElse(null);
    if (helper == null) {
      return false;
    }
    return isInlinableReturnType(helper.getType().asString());
  }

  /** Locals that hold intermediate scalars/arrays — not BUILD targets. */
  private boolean isIntermediateLocalType(String typeAsString) {
    return !isInlinableReturnType(typeAsString);
  }

  /**
   * True for simple null checks: {@code x != null}, {@code x == null}, {@code
   * expr.getFoo() != null}. These are treated as implicit and not surfaced as FILTER.
   */
  private boolean isNullGuard(Expression condition) {
    if (!condition.isBinaryExpr()) {
      return false;
    }
    BinaryExpr bin = condition.asBinaryExpr();
    BinaryExpr.Operator op = bin.getOperator();
    if (op != BinaryExpr.Operator.NOT_EQUALS && op != BinaryExpr.Operator.EQUALS) {
      return false;
    }
    return bin.getLeft().isNullLiteralExpr() || bin.getRight().isNullLiteralExpr();
  }

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

  private String resolveTypeFqcn(String typeName) {
    if (typeName == null || typeName.isBlank()) {
      return typeName;
    }
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

    if (!typeName.contains(".")) {
      return packageName.isEmpty() ? typeName : packageName + "." + typeName;
    }

    return importToBinaryName(typeName);
  }

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

  /** setFoo / getFoo / isFoo → foo. Returns null if not an accessor. */
  private String accessorFieldName(String methodName, String requiredPrefix) {
    if (requiredPrefix != null) {
      if (!methodName.startsWith(requiredPrefix) || methodName.length() <= requiredPrefix.length()) {
        return null;
      }
      String rest = methodName.substring(requiredPrefix.length());
      return Character.toLowerCase(rest.charAt(0)) + rest.substring(1);
    }
    if (methodName.startsWith("get") && methodName.length() > 3) {
      String rest = methodName.substring(3);
      return Character.toLowerCase(rest.charAt(0)) + rest.substring(1);
    }
    if (methodName.startsWith("is") && methodName.length() > 2) {
      String rest = methodName.substring(2);
      return Character.toLowerCase(rest.charAt(0)) + rest.substring(1);
    }
    return null;
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
    if (fqcn == null || fqcn.isBlank()) {
      return fqcn;
    }
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
