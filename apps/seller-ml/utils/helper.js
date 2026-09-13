class Helpers {
  static formatarData(data) {
    if (!data) return 'N/A';
    return new Date(data).toLocaleString('pt-BR');
  }

  static gerarProcessId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  }

  static calcularProgresso(processados, total) {
    if (total === 0) return 0;
    return Math.round((processados / total) * 100);
  }

  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static validarMLBId(mlbId) {
    if (!mlbId) return false;
    const regex = /^MLB\d+$/;
    return regex.test(mlbId.toString().trim());
  }

  static sanitizarString(str) {
    if (!str) return '';
    return str.toString().replace(/[<>"'&]/g, '');
  }

  static formatarMoeda(valor, moeda = 'BRL') {
    if (!valor && valor !== 0) return 'N/A';
    
    const formatters = {
      'BRL': new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }),
      'USD': new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
      'ARS': new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
    };

    const formatter = formatters[moeda] || formatters['BRL'];
    return formatter.format(valor);
  }

  static calcularDesconto(precoOriginal, precoPromocional) {
    if (!precoOriginal || !precoPromocional) return null;
    
    const desconto = precoOriginal - precoPromocional;
    const percentual = (desconto / precoOriginal) * 100;
    
    return {
      valor: desconto,
      percentual: Math.round(percentual * 100) / 100
    };
  }

  static validarEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  }

  static truncarTexto(texto, limite = 100) {
    if (!texto) return '';
    if (texto.length <= limite) return texto;
    return texto.substring(0, limite) + '...';
  }

  static removerAcentos(str) {
    if (!str) return '';
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  static gerarSlug(texto) {
    if (!texto) return '';
    return this.removerAcentos(texto)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim('-');
  }

  static isValidURL(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  static extrairMLBId(url) {
    if (!url) return null;
    
    // Extrair MLB ID de URLs do Mercado Livre
    const regex = /(MLB\d+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
  }

  static formatarBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static gerarResumoProcessamento(resultados) {
    const total = resultados.length;
    const sucessos = resultados.filter(r => r.success).length;
    const erros = total - sucessos;
    const percentualSucesso = total > 0 ? Math.round((sucessos / total) * 100) : 0;

    return {
      total,
      sucessos,
      erros,
      percentual_sucesso: percentualSucesso,
      tempo_processamento: null // Será calculado externamente
    };
  }

  static logProcesso(mensagem, tipo = 'info') {
    const timestamp = new Date().toLocaleString('pt-BR');
    const prefixos = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      debug: '🔍'
    };

    const prefixo = prefixos[tipo] || prefixos.info;
    console.log(`${prefixo} [${timestamp}] ${mensagem}`);
  }
}

module.exports = Helpers;