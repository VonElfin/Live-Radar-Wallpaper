# Live Radar

Um wallpaper interativo para o [Wallpaper Engine](https://www.wallpaperengine.io/) que mostra o tráfego aéreo real ao redor de um ponto configurável, em um estilo visual de radar ATC (torre de controle).

Os dados vêm de redes públicas e voluntárias de recepção ADS-B — não é necessário nenhum hardware de captação, só uma conexão com a internet.

## O que ele faz

- Busca aeronaves reais próximas de uma latitude/longitude configurada, dentro de um raio ajustável.
- Desenha os alvos sobre um mapa escuro (estilo "dark canvas"), com um feixe de radar giratório que "acende" cada contato ao passar por ele.
- Mostra callsign, altitude e velocidade de cada aeronave, com vetor de direção (heading).
- Classifica cada voo em doméstico ou internacional, cruzando o callsign com um banco de rotas.
- Exibe um HUD com contagem de contatos, emergências, desconhecidos, alcance e latência da última atualização.
- Permite clicar em uma aeronave para focar nela, segui-la (follow) e fixá-la em um painel de "tracks".
- Tem um relógio configurável (hora do PC ou UTC manual).
- Todo o layout se adapta à resolução da tela (inclusive monitores verticais) através de um único fator de escala.

## Fontes de dados

O radar consulta três redes ADS-B gratuitas em paralelo e mescla os resultados por hex ICAO, para que a ausência de uma rede não "pisque" contatos que outra ainda enxerga:

- [adsb.one](https://adsb.one/)
- [adsb.lol](https://adsb.lol/)
- [adsb.fi](https://adsb.fi/)

A classificação doméstico/internacional usa o endpoint de rotas do adsb.lol, com fallback nos arquivos estáticos do [VRS standing data](https://github.com/vradarserver/standing-data).

O mapa base é o **Esri World Dark Gray Canvas** (gratuito, sem necessidade de chave de API).

> Nenhuma dessas APIs é afiliada a este projeto; todas são serviços públicos mantidos por voluntários. Respeite os limites de uso de cada uma.

## Estrutura do projeto

```
index.html          Marcação da página e do HUD
css/style.css        Todo o visual (tema "radar verde fosforescente")
js/config.js          Valores padrão de configuração + ponte com o Wallpaper Engine
js/radar.js            Lógica principal: mapa, busca de dados, desenho do radar, HUD, interação
vendor/leaflet/          Biblioteca Leaflet (mapa), incluída localmente
project.json              Manifesto do Wallpaper Engine (propriedades configuráveis pelo usuário)
preview.jpg                Imagem de prévia exibida na Oficina/galeria do Wallpaper Engine
```

## Configuração

Todas as opções abaixo ficam disponíveis no painel de propriedades do Wallpaper Engine (e têm os mesmos valores padrão em `js/config.js`, para que o wallpaper funcione igual quando aberto direto no navegador):

| Categoria  | Propriedades |
|---|---|
| Localização | Latitude, Longitude, Raio (km), Fonte de dados |
| HUD | Mostrar HUD, Mostrar relógio, Usar hora do PC, Relógio 24h, Offset UTC |
| Filtros | Altitude mín/máx, Velocidade mín/máx, Tipo de voo (doméstico/internacional) |
| Exibição | Velocidade do radar (RPM), Modo de revelação dos contatos, Persistência do blip, Modo de rótulos, Vetores, Anéis, Mapa, Rótulos de cidade |
| Layout | Auto zoom, Offset de zoom, Escala da UI, Margem inferior (barra de tarefas), Mostrar botões |

## Rodando localmente

Como o app faz `fetch` para APIs externas, ele precisa ser servido por HTTP (não abrir o `index.html` direto via `file://`, pois o navegador bloqueia essas requisições por CORS/origem). Qualquer servidor estático simples resolve, por exemplo:

```
npx serve .
```

Depois é só abrir a URL local no navegador. Sem o Wallpaper Engine, o app usa os valores padrão definidos em `js/config.js`.

## Créditos

- Mapa: [Esri World Dark Gray Canvas](https://www.arcgis.com/home/item.html?id=1970c1995b8f44749f4b9b6e81b5ba45), © Esri, HERE, Garmin, OpenStreetMap contributors
- Mapa/UI: [Leaflet](https://leafletjs.com/)
- Dados de voo: adsb.one, adsb.lol, adsb.fi
- Rotas: adsb.lol routeset API e VRS standing data
