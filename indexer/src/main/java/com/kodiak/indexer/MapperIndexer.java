package com.kodiak.indexer;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
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
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Deterministic JavaParser walk of a mapper entry method into AST steps.
 * Unrecognized shapes become RAW — never guessed.
 */
public class MapperIndexer {

  public IndexResult index(MapperEntry entry, Path sourceRoot) {
    Path sourceFile = sourceRoot.resolve(entry.getSourceFile());
    CompilationUnit unit;
    try {
      unit = StaticJavaParser.parse(sourceFile);
    } catch (IOException e) {
      throw new IndexingException("Failed to read source file: " + sourceFile, e);
    }

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
    result
        .getSteps()
        .addAll(indexBlock(classDecl, entryMethod.getBody().orElse(new BlockStmt()), visited));
    return result;
  }

  private List<AstStep> indexBlock(
      ClassOrInterfaceDeclaration classDecl, BlockStmt block, Set<String> visited) {
    List<AstStep> steps = new ArrayList<>();
    for (Statement stmt : block.getStatements()) {
      steps.add(classify(classDecl, stmt, visited));
    }
    return steps;
  }

  private AstStep classify(ClassOrInterfaceDeclaration classDecl, Statement stmt, Set<String> visited) {
    if (stmt.isReturnStmt()) {
      ReturnStmt ret = stmt.asReturnStmt();
      return ret.getExpression()
          .map(expr -> AstStep.write("<return>", expr.toString(), stmt.toString()))
          .orElse(AstStep.raw(stmt.toString()));
    }

    if (stmt.isIfStmt()) {
      IfStmt ifStmt = stmt.asIfStmt();
      List<AstStep> thenSteps =
          indexBlock(
              classDecl, ifStmt.getThenStmt().asBlockStmt(), new HashSet<>(visited));
      return AstStep.filter(ifStmt.getCondition().toString(), thenSteps, stmt.toString());
    }

    if (stmt.isExpressionStmt()) {
      ExpressionStmt exprStmt = stmt.asExpressionStmt();
      Expression expr = exprStmt.getExpression();

      if (expr.isAssignExpr()) {
        return AstStep.raw(stmt.toString());
      }

      if (expr.isMethodCallExpr()) {
        MethodCallExpr call = expr.asMethodCallExpr();
        if (call.getNameAsString().startsWith("set") && call.getArguments().size() == 1) {
          String targetField = call.getNameAsString().substring(3);
          targetField = Character.toLowerCase(targetField.charAt(0)) + targetField.substring(1);
          String sourceField = call.getArgument(0).toString();
          return AstStep.write(targetField, sourceField, stmt.toString());
        }
      }

      if (expr.isVariableDeclarationExpr()) {
        VariableDeclarationExpr varDecl = expr.asVariableDeclarationExpr();
        for (VariableDeclarator var : varDecl.getVariables()) {
          if (var.getInitializer().isPresent() && var.getInitializer().get().isMethodCallExpr()) {
            MethodCallExpr init = var.getInitializer().get().asMethodCallExpr();
            return AstStep.build(var.getNameAsString(), init.toString(), stmt.toString());
          }
        }
      }
    }

    return AstStep.raw(stmt.toString());
  }

  private MethodDeclaration findMethod(ClassOrInterfaceDeclaration classDecl, String name) {
    return classDecl.getMethodsByName(name).stream()
        .findFirst()
        .orElseThrow(
            () -> new IndexingException("Method " + name + " not found in " + classDecl.getName(), null));
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
