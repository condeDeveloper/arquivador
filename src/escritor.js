/**
 * O escritor.
 *
 * Acumula blocos e no fim acrescenta **dois blocos zerados**, que é como um
 * tar declara que acabou. Um tar sem eles é lido por algumas ferramentas e
 * recusado por outras — e o `tar` do GNU avisa "unexpected EOF".
 */

import { createReadStream } from 'node:fs';
import { readdir, readlink, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { BLOCO, ErroDeFormato, TIPOS, enchimento, montarCabecalho } from './cabecalho.js';

/** Nome que o GNU usa na entrada que carrega um caminho comprido. */
export const NOME_LONGO = '././@LongLink';

/** Monta um arquivo tar em memória. */
export class Escritor {
  constructor() {
    this.pedacos = [];
    this.fechado = false;
    this.entradas = 0;
  }

  /** Quantos bytes já foram escritos. */
  get tamanho() {
    return this.pedacos.reduce((total, p) => total + p.length, 0);
  }

  escrever(bytes) {
    if (this.fechado) throw new ErroDeFormato('O arquivo já foi finalizado.');

    this.pedacos.push(bytes);
  }

  /** Completa o último bloco com zeros. */
  encher(tamanho) {
    const falta = enchimento(tamanho);

    if (falta > 0) this.escrever(Buffer.alloc(falta));
  }

  /**
   * Acrescenta uma entrada.
   *
   * @param {{nome: string, tipo?: string, modo?: number, alterado?: Date, destino?: string}} entrada
   * @param {Buffer|string} conteudo
   */
  adicionar(entrada, conteudo = Buffer.alloc(0)) {
    const corpo = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
    const tipo = entrada.tipo ?? TIPOS.arquivo;
    const limpo = normalizar(entrada.nome);

    if (limpo === '') throw new ErroDeFormato('Entrada sem nome.');

    // A barra no fim é o que marca um diretório no tar, e `normalizar` a tira
    // junto com as outras. Sem devolvê-la, o `tar` do sistema extrai a pasta
    // como se fosse um arquivo vazio de mesmo nome.
    const nome = tipo === TIPOS.diretorio ? `${limpo}/` : limpo;

    // Caminho que não cabe no ustar vai numa entrada `L` antes, com o nome
    // inteiro como conteúdo. É a extensão do GNU, e é o que o `tar` de
    // qualquer Linux lê sem reclamar.
    if (Buffer.byteLength(nome) > 100 && !cabeNoUstar(nome)) {
      this.escreverNomeLongo(nome, entrada.alterado);
    }

    const cheia = { ...entrada, nome: cabeNoUstar(nome) ? nome : nome.slice(0, 100), tamanho: corpo.length, tipo };

    this.escrever(montarCabecalho(cheia));

    if (cheia.tipo === TIPOS.arquivo && corpo.length > 0) {
      this.escrever(corpo);
      this.encher(corpo.length);
    }

    this.entradas += 1;

    return this;
  }

  /** A entrada `L` que carrega um caminho comprido. */
  escreverNomeLongo(nome, alterado) {
    const bytes = Buffer.from(`${nome}\0`, 'utf8');

    this.escrever(montarCabecalho({
      nome: NOME_LONGO,
      tipo: TIPOS.nomeLongoGnu,
      tamanho: bytes.length,
      modo: 0,
      alterado: alterado ?? new Date(0),
    }));

    this.escrever(bytes);
    this.encher(bytes.length);
  }

  /** Atalho para uma pasta. */
  adicionarPasta(nome, opcoes = {}) {
    return this.adicionar({ modo: 0o755, ...opcoes, nome, tipo: TIPOS.diretorio });
  }

  /** Atalho para uma ligação simbólica. */
  adicionarSimbolica(nome, destino, opcoes = {}) {
    return this.adicionar({ modo: 0o777, ...opcoes, nome, destino, tipo: TIPOS.simbolica });
  }

  /** Fecha o arquivo com os dois blocos zerados e devolve os bytes. */
  finalizar() {
    if (!this.fechado) {
      // Dois blocos, não um: é o que a especificação manda e o que o `tar`
      // do GNU procura antes de declarar o arquivo íntegro.
      this.pedacos.push(Buffer.alloc(BLOCO * 2));
      this.fechado = true;
    }

    return Buffer.concat(this.pedacos);
  }
}

/** Indica se o caminho cabe nos campos do ustar. */
export function cabeNoUstar(caminho) {
  const bytes = Buffer.byteLength(caminho);

  if (bytes <= 100) return true;
  if (bytes > 255) return false;

  for (let i = caminho.length - 1; i >= 0; i -= 1) {
    if (caminho[i] !== '/') continue;

    if (Buffer.byteLength(caminho.slice(i + 1)) <= 100 && Buffer.byteLength(caminho.slice(0, i)) <= 155) {
      return true;
    }
  }

  return false;
}

/** Caminho sempre com barra e sempre relativo. */
export function normalizar(caminho) {
  return String(caminho).split(sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Lê um arquivo do disco inteiro. */
async function lerArquivo(caminho) {
  const pedacos = [];

  for await (const pedaco of createReadStream(caminho)) pedacos.push(pedaco);

  return Buffer.concat(pedacos);
}

/**
 * Empacota uma pasta inteira.
 *
 * A ordem é alfabética e o instante de cada entrada pode ser fixado: sem isso,
 * empacotar a mesma pasta duas vezes gera arquivos com bytes diferentes, e
 * nenhuma verificação por hash funciona.
 */
export async function empacotar(raiz, { alterado = null, ignorar = () => false } = {}) {
  const escritor = new Escritor();

  const andar = async (pasta) => {
    const itens = (await readdir(pasta, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const item of itens) {
      const cheio = join(pasta, item.name);
      const nome = normalizar(relative(raiz, cheio));

      if (ignorar(nome)) continue;

      const info = await stat(cheio).catch(() => null);
      const quando = alterado ?? (info ? info.mtime : new Date());

      if (item.isSymbolicLink()) {
        escritor.adicionarSimbolica(nome, await readlink(cheio), { alterado: quando });
        continue;
      }

      if (item.isDirectory()) {
        escritor.adicionarPasta(nome, { alterado: quando, modo: info?.mode & 0o777 });
        await andar(cheio);
        continue;
      }

      if (!item.isFile()) continue;

      escritor.adicionar(
        { nome, alterado: quando, modo: (info?.mode & 0o777) || 0o644 },
        await lerArquivo(cheio),
      );
    }
  };

  await andar(raiz);

  return escritor.finalizar();
}
