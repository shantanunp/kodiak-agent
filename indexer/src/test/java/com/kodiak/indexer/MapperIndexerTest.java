package com.kodiak.indexer;

import com.kodiak.indexer.registry.MapperEntry;
import com.kodiak.indexer.registry.RegistryDocument;
import com.kodiak.indexer.registry.RegistryLoader;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
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
}
