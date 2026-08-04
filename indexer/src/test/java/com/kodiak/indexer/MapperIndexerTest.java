package com.kodiak.indexer;

import com.kodiak.indexer.model.AstStep;
import com.kodiak.indexer.model.IndexResult;
import com.kodiak.indexer.registry.MapperEntry;
import com.kodiak.indexer.registry.RegistryDocument;
import com.kodiak.indexer.registry.RegistryLoader;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MapperIndexerTest {

  @Test
  void indexesDemoMapper() throws Exception {
    Path registry = Path.of("../registry/mapping-registry.yaml").toAbsolutePath().normalize();
    Path worktree = Path.of("..").toAbsolutePath().normalize();

    RegistryDocument doc = new RegistryLoader().load(registry);
    MapperEntry entry =
        doc.getMappers().stream()
            .filter(m -> "demo-ai-recognition-mapper".equals(m.getId()))
            .findFirst()
            .orElseThrow();

    // Demo mapper source lives in remote repo — skip if not present locally
    Path source = worktree.resolve(entry.getSourceFile());
    if (!source.toFile().exists()) {
      return;
    }

    var result = new MapperIndexer().index(entry, worktree);
    assertFalse(result.getOperations().isEmpty());
    assertTrue(
        result.getOperations().stream()
            .anyMatch(s -> s.getKind().name().equals("RAW") || s.getKind().name().equals("READ")
                || s.getKind().name().equals("BUILD") || s.getKind().name().equals("WRITE")),
        "expected at least one classified operation");
  }

  @Test
  void scalarStringHelperSetterBundlesHelperBodyAsRaw() {
    Path worktree = Path.of("src/test/resources").toAbsolutePath().normalize();
    MapperEntry entry = new MapperEntry();
    entry.setId("scalar-helper-mapper");
    entry.setSourceFile("fixtures/ScalarHelperMapper.java");
    entry.setClassName("fixtures.ScalarHelperMapper");
    entry.setEntryMethod("map");
    entry.setSourceType("fixtures.ScalarHelperMapper.Source");
    entry.setTargetType("fixtures.ScalarHelperMapper.Target");

    IndexResult result = new MapperIndexer().index(entry, worktree);
    AstStep address =
        result.getOperations().stream()
            .filter(s -> s.getTargetField() != null && s.getTargetField().endsWith("addressLineText"))
            .findFirst()
            .orElse(null);

    assertNotNull(address, "expected addressLineText step");
    assertTrue(address.getKind() == AstStep.Kind.RAW, "scalar helper should be RAW, not bare WRITE");
    Object code = address.getMeta() != null ? address.getMeta().get("code") : null;
    assertNotNull(code);
    String codeText = code.toString();
    assertTrue(codeText.contains("mapAddressLineViaOptional"), codeText);
    assertTrue(codeText.contains("String::trim"), codeText);
    assertTrue(codeText.contains("Property::getStreet"), codeText);
  }
}
