package com.kodiak.indexer.registry;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.yaml.snakeyaml.Yaml;

public class RegistryLoader {

  public RegistryDocument load(Path registryFile) throws IOException {
    Yaml yaml = new Yaml();
    try (InputStream in = Files.newInputStream(registryFile)) {
      Object root = yaml.load(in);
      if (!(root instanceof Map<?, ?> map)) {
        throw new IllegalArgumentException("Registry root must be a mapping");
      }
      RegistryDocument doc = new RegistryDocument();
      doc.setRepo(string(map.get("repo")));
      doc.setBranch(string(map.get("branch")));
      doc.setScope(stringList(map.get("scope")));
      doc.setMappers(parseMappers(map.get("mappers")));
      return doc;
    }
  }

  @SuppressWarnings("unchecked")
  private List<MapperEntry> parseMappers(Object raw) {
    if (!(raw instanceof List<?> list)) {
      return List.of();
    }
    List<MapperEntry> entries = new ArrayList<>();
    for (Object item : list) {
      if (!(item instanceof Map<?, ?> map)) {
        continue;
      }
      MapperEntry entry = new MapperEntry();
      entry.setId(string(map.get("id")));
      entry.setSourceFile(string(map.get("sourceFile")));
      entry.setClassName(string(map.get("class")));
      entry.setEntryMethod(string(map.get("entryMethod")));
      entry.setSourceType(string(map.get("sourceType")));
      entry.setTargetType(string(map.get("targetType")));
      entry.setGoldenTests(string(map.get("goldenTests")));
      entries.add(entry);
    }
    return entries;
  }

  @SuppressWarnings("unchecked")
  private List<String> stringList(Object raw) {
    if (!(raw instanceof List<?> list)) {
      return List.of();
    }
    List<String> out = new ArrayList<>();
    for (Object item : list) {
      if (item != null) {
        out.add(item.toString());
      }
    }
    return out;
  }

  private String string(Object raw) {
    return raw == null ? null : raw.toString();
  }
}
