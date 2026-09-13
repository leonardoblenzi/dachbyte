// controllers/HtmlController.js
"use strict";

const fs = require("fs");
const path = require("path");

class HtmlController {
  static servirPainel(_req, res) {
    const htmlPath = path.join(__dirname, "../views/painel.html");
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    return res.status(404).send(`
      <h1>Arquivo painel.html nao encontrado</h1>
      <p>Crie o arquivo em <code>views/painel.html</code>.</p>
    `);
  }

  static servirProjecaoMensal(_req, res) {
    const htmlPath = path.join(__dirname, "../views/projecao-mensal.html");
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    return res.status(404).send(`
      <h1>Arquivo projecao-mensal.html nao encontrado</h1>
      <p>Crie o arquivo em <code>views/projecao-mensal.html</code>.</p>
      <p><a href="/criar-projecao-exemplo">Criar exemplo de projecao</a></p>
    `);
  }

  static servirRemoverPromocao(_req, res) {
    const htmlPath = path.join(__dirname, "../views/remover-promocao.html");
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    return res.status(404).send(`
      <h1>Arquivo remover-promocao.html nao encontrado</h1>
      <p>Crie o arquivo em <code>views/remover-promocao.html</code>.</p>
    `);
  }

  static criarPromocao(_req, res) {
    const htmlPath = path.join(__dirname, "../views/criar-promocao.html");
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    return res.status(404).send(`
      <h1>Arquivo criar-promocao.html nao encontrado</h1>
      <p>Crie o arquivo em <code>views/criar-promocao.html</code>.</p>
      <p><a href="/projecao-mensal">Voltar para Projecao Mensal</a></p>
    `);
  }

  static criarDashboard(_req, res) {
    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Mercado Livre - Dashboard (EXEMPLO)</title>
  <link rel="stylesheet" href="/css/ml-app.css">
</head>
<body>
  <div class="container">
    <h1>Dashboard de Exemplo</h1>
    <p>Este arquivo foi gerado automaticamente e nao substitui seu dashboard real.</p>
    <div class="endpoints">
      <div class="endpoint">
        <h3>Gerenciar Token <span class="status warning">IMPORTANTE</span></h3>
        <p>Verificar e renovar ACCESS_TOKEN</p>
        <div class="token-actions">
          <button onclick="alert('Exemplo')">Verificar Token</button>
          <button onclick="alert('Exemplo')">Renovar Token</button>
        </div>
      </div>
      <div class="endpoint">
        <h3>Remover Promocoes <span class="status active">ATIVO</span></h3>
        <p>Interface para remover promocoes de anuncios</p>
        <a href="/remover-promocao">Acessar Interface</a>
      </div>
    </div>
    <p style="margin-top:18px;">
      Sua tela real de projecao mensal esta em <code>views/projecao-mensal.html</code>
      e e servida em <a href="/projecao-mensal">/projecao-mensal</a>.
    </p>
  </div>
</body>
</html>`;

    const examplePath = path.join(__dirname, "../views/projecao-mensal.example.html");

    try {
      fs.writeFileSync(examplePath, htmlContent, "utf8");
      return res.send(`
        <h1>Exemplo de projecao criado</h1>
        <p>O arquivo <strong>projecao-mensal.example.html</strong> foi criado em:</p>
        <p><code>${examplePath}</code></p>
        <p><strong>Sua tela real de projecao mensal nao foi alterada.</strong></p>
        <p><a href="/projecao-mensal">Ir para /projecao-mensal</a></p>
      `);
    } catch (error) {
      return res.status(500).send(`
        <h1>Erro ao criar exemplo de projecao</h1>
        <p>Erro: ${error.message}</p>
      `);
    }
  }
}

module.exports = HtmlController;
