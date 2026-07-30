package com.kodiak.indexer;

import com.kodiak.indexer.registry.MapperEntry;
import com.kodiak.indexer.registry.RegistryDocument;
import com.kodiak.indexer.registry.RegistryLoader;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MapperIndexerTest {

  @Test
  void indexesExampleMapperWithRawAndWriteSteps() throws Exception {
    Path registry = Path.of("../registry/mapping-registry.yaml").toAbsolutePath().normalize();
    Path worktree = Path.of("..").toAbsolutePath().normalize();

    RegistryDocument doc = new RegistryLoader().load(registry);
    MapperEntry entry =
        doc.getMappers().stream()
            .filter(m -> "example-mapper".equals(m.getId()))
            .findFirst()
            .orElseThrow();

    var result = new MapperIndexer().index(entry, worktree);

    assertEquals("example-mapper", result.getMapperId());
    assertFalse(result.getSteps().isEmpty());
    assertTrue(
        result.getSteps().stream().anyMatch(s -> s.getKind().name().equals("WRITE")),
        "expected at least one WRITE step");
    assertTrue(
        result.getSteps().stream().anyMatch(s -> s.getKind().name().equals("RAW")),
        "expected at least one RAW step for direct field assignment");
  }
}
