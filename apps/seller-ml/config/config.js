const path = require('path');
module.exports = {
  diretorio_saida: process.env.OUTPUT_DIR || path.join(__dirname, '..', 'results'),
  arquivo_csv: 'anuncios_ativos_promocao.csv',
  encoding: 'utf8',
  port: process.env.PORT || 3000,
  delay_padrao_remocao: Number(process.env.DEFAULT_REMOVE_DELAY || 3000),
  
  // URLs da API do Mercado Livre
  urls: {
    oauth_token: 'https://api.mercadolibre.com/oauth/token',
    users_me: 'https://api.mercadolibre.com/users/me',
    seller_promotions: 'https://api.mercadolibre.com/seller-promotions',
    ads: {
  // Ajuste para o endpoint que você já usa de Mercado Ads / Sponsored Products
  listing_report: 'https://api.mercadolibre.com/advertising/product_ads/listings/report',
},

  }
};