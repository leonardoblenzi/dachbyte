const fs = require('fs');
const path = require('path');
const config = require('../config/config');

class PromocaoCSVManager {
  constructor() {
    this.diretorioSaida = config.diretorio_saida;
    this.arquivoCSV = path.join(this.diretorioSaida, config.arquivo_csv);
    
    if (!fs.existsSync(this.diretorioSaida)) {
      fs.mkdirSync(this.diretorioSaida, { recursive: true });
    }

    this.headers = [
      'id', 'titulo', 'preco_original', 'preco_promocional', 'desconto_percentual',
      'desconto_valor', 'moeda', 'status', 'condicao', 'categoria', 'vendidos',
      'disponivel', 'tipo_promocao', 'inicio_promocao', 'fim_promocao',
      'link', 'thumbnail', 'criado_em', 'processado_em'
    ];
  }

  escaparCSV(valor) {
    if (valor === null || valor === undefined) return '';
    const str = String(valor).replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  inicializarCSV() {
    const headerLine = this.headers.join(',') + '\n';
    fs.writeFileSync(this.arquivoCSV, '\ufeff' + headerLine, config.encoding);
    console.log(`✅ Arquivo CSV criado: ${this.arquivoCSV}`);
  }

  adicionarAnuncios(anuncios) {
    const linhas = anuncios.map(anuncio => {
      return [
        this.escaparCSV(anuncio.id),
        this.escaparCSV(anuncio.titulo),
        this.escaparCSV(anuncio.preco_original),
        this.escaparCSV(anuncio.preco_promocional),
        this.escaparCSV(anuncio.desconto_percentual),
        this.escaparCSV(anuncio.desconto_valor),
        this.escaparCSV(anuncio.moeda),
        this.escaparCSV(anuncio.status),
        this.escaparCSV(anuncio.condicao),
        this.escaparCSV(anuncio.categoria),
        this.escaparCSV(anuncio.vendidos),
        this.escaparCSV(anuncio.disponivel),
        this.escaparCSV(anuncio.tipo_promocao),
        this.escaparCSV(anuncio.inicio_promocao),
        this.escaparCSV(anuncio.fim_promocao),
        this.escaparCSV(anuncio.link),
        this.escaparCSV(anuncio.thumbnail),
        this.escaparCSV(anuncio.criado_em),
        this.escaparCSV(new Date().toLocaleString('pt-BR'))
      ].join(',');
    }).join('\n');

    fs.appendFileSync(this.arquivoCSV, linhas + '\n', config.encoding);
    console.log(`✅ ${anuncios.length} anúncios com promoção adicionados ao CSV`);
  }

  verificarArquivoExiste() {
    return fs.existsSync(this.arquivoCSV);
  }

  obterCaminhoArquivo() {
    return this.arquivoCSV;
  }

  obterEstatisticas() {
    if (!this.verificarArquivoExiste()) {
      return {
        existe: false,
        total_linhas: 0,
        tamanho_arquivo: 0
      };
    }

    const stats = fs.statSync(this.arquivoCSV);
    const conteudo = fs.readFileSync(this.arquivoCSV, config.encoding);
    const linhas = conteudo.split('\n').filter(linha => linha.trim());

    return {
      existe: true,
      total_linhas: linhas.length - 1, // Subtrair header
      tamanho_arquivo: stats.size,
      data_modificacao: stats.mtime,
      caminho: this.arquivoCSV
    };
  }

  // Adicionar este método ao csvManager existente
async processarCSVPromocoes(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        let linha = 0;
        
        fs.createReadStream(filePath)
            .pipe(csv({
                headers: ['id', 'price', 'start_date', 'end_date', 'promotion_id'],
                skipEmptyLines: true
            }))
            .on('data', (data) => {
                linha++;
                if (linha === 1) return; // Pular cabeçalho
                
                // Validar e limpar dados
                const item = {
                    id: data.id?.trim(),
                    price: data.price?.trim(),
                    start_date: data.start_date?.trim(),
                    end_date: data.end_date?.trim(),
                    promotionId: data.promotion_id?.trim(),
                    linha: linha
                };
                
                if (item.id) {
                    results.push(item);
                }
            })
            .on('end', () => {
                // Limpar arquivo temporário
                fs.unlink(filePath, (err) => {
                    if (err) console.error('Erro ao deletar arquivo temporário:', err);
                });
                resolve(results);
            })
            .on('error', (error) => {
                reject(error);
            });
    });
}
}

module.exports = PromocaoCSVManager;