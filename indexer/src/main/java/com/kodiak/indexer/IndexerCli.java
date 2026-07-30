package com.kodiak.indexer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.kodiak.indexer.model.IndexResult;
import com.kodiak.indexer.registry.MapperEntry;
import com.kodiak.indexer.registry.RegistryDocument;
import com.kodiak.indexer.registry.RegistryLoader;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Usage: java -jar kodiak-indexer.jar &lt;registry-file&gt; [mapper-id] [--worktree &lt;path&gt;]
 *
 * <p>Prints one IndexResult JSON object per mapper to stdout. Deterministic only — no AI.
 */
public class IndexerCli {

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("Usage: indexer <registry-file> [mapper-id] [--worktree <path>]");
      System.exit(1);
    }

    Path registryFile = Path.of(args[0]);
    String onlyId = null;
    Path worktree = Paths.get("").toAbsolutePath();

    for (int i = 1; i < args.length; i++) {
      if ("--worktree".equals(args[i]) && i + 1 < args.length) {
        worktree = Path.of(args[++i]).toAbsolutePath();
      } else if (!args[i].startsWith("--") && onlyId == null) {
        onlyId = args[i];
      }
    }

    RegistryDocument doc = new RegistryLoader().load(registryFile);
    if (doc.getWorktreeRoot() != null && !doc.getWorktreeRoot().isBlank()) {
      worktree = Path.of(doc.getWorktreeRoot()).toAbsolutePath();
    }

    MapperIndexer indexer = new MapperIndexer();
    ObjectMapper json = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    for (MapperEntry entry : doc.getMappers()) {
      if (onlyId != null && !onlyId.equals(entry.getId())) {
        continue;
      }
      IndexResult result = indexer.index(entry, worktree);
      System.out.println(json.writeValueAsString(result));
    }
  }
}
