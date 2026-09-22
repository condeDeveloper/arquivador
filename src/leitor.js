/**
 * O leitor.
 *
 * Percorre os blocos do começo ao fim. Não há índice num tar, então não há
 * como pular direto para uma entrada: a única forma de achar o próximo
 * cabeçalho é somar o tamanho do conteúdo atual arredondado para 512.
 *
 * Duas extensões aparecem em quase todo tar do mundo real e precisam ser
 * entendidas, senão o nome do arquivo volta cortado:
 *
 * - **GNU `L`**: uma entrada cujo conteúdo é o caminho comprido da entrada
 *   seguinte.
 * - **PAX `x`**: registros `tamanho chave=valor\n`, usados para caminho,
 *   instante com fração de segundo e tamanho acima de 8 GB.
 */

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { BLOCO, ErroDeFormato, TIPOS, enchimento, lerCabecalho } from './cabecalho.js';

/** Percorre as entradas de um tar em memória. */
export function* lerEntradas(bytes, { pararNoFim = true } = {}) {
  let i = 0;
  let nomeLongo = null;
  let pax = null;
  let zerados = 0;

  while (i + BLOCO <= bytes.length) {
    const bloco = bytes.subarray(i, i + BLOCO);
    const cabecalho = lerCabecalho(bloco, i);

    if (cabecalho === null) {
      zerados += 1;
      i += BLOCO;

      // Dois blocos zerados seguidos são o fim do arquivo.
      if (zerados >= 2 && pararNoFim) return;

      continue;
    }

    zerados = 0;
    i += BLOCO;

    const conteudo = bytes.subarray(i, i + cabecalho.tamanho);

    if (conteudo.length < cabecalho.tamanho) {
      throw new ErroDeFormato(
        `A entrada "${cabecalho.nome}" declara ${cabecalho.tamanho} bytes e o arquivo acabou antes`,
        i,
      );
    }

    i += cabecalho.tamanho + enchimento(cabecalho.tamanho);

    if (cabecalho.tipo === TIPOS.nomeLongoGnu) {
      nomeLongo = conteudo.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    if (cabecalho.tipo === TIPOS.pax || cabecalho.tipo === TIPOS.paxGlobal) {
      pax = lerPax(conteudo);
      continue;
    }

    const entrada = { ...cabecalho, conteudo };

    if (nomeLongo !== null) {
      entrada.nome = nomeLongo;
      nomeLongo = null;
    }

    if (pax !== null) {
      if (pax.path) entrada.nome = pax.path;
      if (pax.size) entrada.tamanho = Number(pax.size);
      if (pax.mtime) entrada.alterado = new Date(Number(pax.mtime) * 1000);

      entrada.pax = pax;
      pax = null;
    }

    yield entrada;
  }
}

/**
 * Lê os registros PAX.
 *
 * O formato é `<tamanho> <chave>=<valor>\n`, e o tamanho **inclui ele
 * mesmo** — outra vez um campo que se mede. Contar só o resto desalinha todos
 * os registros seguintes.
 */
export function lerPax(bytes) {
  const registros = Object.create(null);
  const texto = bytes.toString('utf8');

  let i = 0;

  while (i < texto.length) {
    const espaco = texto.indexOf(' ', i);

    if (espaco < 0) break;

    const tamanho = Number(texto.slice(i, espaco));

    if (!Number.isInteger(tamanho) || tamanho <= 0) {
      throw new ErroDeFormato(`Registro PAX com tamanho inválido: ${JSON.stringify(texto.slice(i, espaco))}`);
    }

    const registro = texto.slice(espaco + 1, i + tamanho).replace(/\n$/, '');
    const igual = registro.indexOf('=');

    if (igual > 0) registros[registro.slice(0, igual)] = registro.slice(igual + 1);

    i += tamanho;
  }

  return registros;
}

/** Lista as entradas, sem o conteúdo. */
export function listar(bytes) {
  return [...lerEntradas(bytes)].map(({ conteudo, ...resto }) => resto);
}

/** Busca uma entrada pelo nome. */
export function buscar(bytes, nome) {
  for (const entrada of lerEntradas(bytes)) {
    if (entrada.nome === nome || entrada.nome === `${nome}/`) return entrada;
  }

  return null;
}

/**
 * Resolve um caminho de dentro do arquivo, garantindo que ele fique na pasta.
 *
 * É a defesa contra o *tar slip*: um arquivo malicioso traz uma entrada
 * chamada `../../.ssh/authorized_keys`, e um extrator ingênuo — que só faz
 * `join(destino, nome)` — escreve exatamente ali. O mesmo vale para caminho
 * absoluto e para ligação simbólica apontando para fora.
 */
export function resolverDentro(destino, nome) {
  const raiz = resolve(destino);
  const alvo = resolve(raiz, nome);
  const dentro = relative(raiz, alvo);

  if (dentro === '') return raiz;

  if (dentro.startsWith('..') || dentro.split(sep).includes('..') || resolve(dentro) === dentro) {
    return null;
  }

  return alvo;
}

/**
 * Extrai o arquivo para uma pasta.
 *
 * Entradas que escapam da pasta são recusadas; com `pularPerigosas` elas são
 * ignoradas e listadas no resultado, em vez de derrubar a extração inteira.
 */
export async function extrair(bytes, destino, { pularPerigosas = false, simbolicas = true } = {}) {
  const escritos = [];
  const recusados = [];

  for (const entrada of lerEntradas(bytes)) {
    const alvo = resolverDentro(destino, entrada.nome);

    if (alvo === null) {
      if (!pularPerigosas) {
        throw new ErroDeFormato(`A entrada "${entrada.nome}" escaparia da pasta de destino`);
      }

      recusados.push(entrada.nome);
      continue;
    }

    if (entrada.tipo === TIPOS.diretorio) {
      await mkdir(alvo, { recursive: true });
      escritos.push(entrada.nome);
      continue;
    }

    if (entrada.tipo === TIPOS.simbolica) {
      if (!simbolicas) {
        recusados.push(entrada.nome);
        continue;
      }

      // A ligação também precisa apontar para dentro: `link -> /etc/passwd`
      // seguido de uma escrita nesse link escaparia sem nenhum `..` no nome.
      if (resolverDentro(destino, join(dirname(entrada.nome), entrada.destino)) === null) {
        if (!pularPerigosas) {
          throw new ErroDeFormato(`A ligação "${entrada.nome}" apontaria para fora da pasta`);
        }

        recusados.push(entrada.nome);
        continue;
      }

      await mkdir(dirname(alvo), { recursive: true });
      await symlink(entrada.destino, alvo).catch(() => recusados.push(entrada.nome));
      escritos.push(entrada.nome);
      continue;
    }

    if (entrada.tipo !== TIPOS.arquivo) continue;

    await mkdir(dirname(alvo), { recursive: true });
    await writeFile(alvo, entrada.conteudo);
    escritos.push(entrada.nome);
  }

  return { escritos, recusados };
}
