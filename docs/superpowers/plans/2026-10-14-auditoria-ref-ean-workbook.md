# Planilha de correção de REF por EAN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar uma planilha Excel somente com os registros que exigem revisão ou substituição de REF com base no EAN.

**Architecture:** Ler a planilha principal e os cadastros Tray, consolidar as referências por EAN e emitir uma aba `Erros`. Cada linha da saída indica se uma REF pode ser substituída ou se exige revisão manual.

**Tech Stack:** Python de runtime, `openpyxl` para leitura, `@oai/artifact-tool` para criação do XLSX.

---

### Task 1: Consolidar os registros de erro

**Files:**
- Create: `scripts/build_ref_ean_corrections.mjs`
- Test: `scripts/build_ref_ean_corrections.test.mjs`

- [ ] **Step 1: Escrever o teste de classificação**

```javascript
assert.equal(classify({ ean: "7908670840700", ref: "19689" }, { refs: ["38343"] }), "REF divergente");
assert.equal(classify({ ean: "", ref: "123" }, null), "EAN ausente ou inválido");
assert.equal(classify({ ean: "123", ref: "123" }, null), "EAN não localizado");
```

- [ ] **Step 2: Executar o teste e confirmar que ele falha**

Run: `node scripts/build_ref_ean_corrections.test.mjs`

Expected: falha porque `classify` ainda não existe.

- [ ] **Step 3: Implementar a classificação e a consolidação**

```javascript
function classify(master, source) {
  if (!master.ean || master.ean === "-1") return "EAN ausente ou inválido";
  if (!source) return "EAN não localizado";
  return source.refs.includes(master.ref) ? null : "REF divergente";
}
```

- [ ] **Step 4: Executar o teste e confirmar que passa**

Run: `node scripts/build_ref_ean_corrections.test.mjs`

Expected: PASS.

### Task 2: Criar e verificar o XLSX de saída

**Files:**
- Modify: `scripts/build_ref_ean_corrections.mjs`
- Create: `outputs/ref-ean-correcoes.xlsx`

- [ ] **Step 1: Escrever os erros em uma aba `Erros`**

```javascript
sheet.getRange("A1:H1").values = [["Status", "EAN", "REF atual", "REF verdadeira", "MLB", "SKU", "Título", "Origem da REF verdadeira"]];
sheet.getRange(`A2:H${rows.length + 1}`).values = rows;
```

- [ ] **Step 2: Aplicar filtros, congelar o cabeçalho e formatar identificadores como texto**

```javascript
sheet.getRange("A1:H1").format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" } };
sheet.freezePanes.freezeRows(1);
```

- [ ] **Step 3: Exportar, inspecionar a tabela e procurar erros de fórmula**

Run: `node scripts/build_ref_ean_corrections.mjs`

Expected: `outputs/ref-ean-correcoes.xlsx` contém somente registros dos três status definidos, sem fórmulas com erro.
