#!/usr/bin/env node
/**
 * A linha de comando.
 *
 * As três letras clássicas do tar: `c` cria, `t` lista, `x` extrai.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIPOS } from './cabecalho.js';
import { empacotar } from './escritor.js';
import { extrair, listar } from './leitor.js';

const AJUDA = `arquivador — tar POSIX ustar, do zero

  arq criar <saida.tar> <pasta>     empacota a pasta
  arq listar <arquivo.tar>          lista o conteúdo
  arq extrair <arquivo.tar> <pasta> extrai para a pasta

  -v, --detalhado   mostra modo, tamanho e data, como o "tar -tv"
  -f, --fixar       fixa a data em 1970 (empacotar duas vezes dá bytes iguais)
  -s, --sem-medo    pula entradas que escapariam da pasta, em vez de parar
  -h, --ajuda`;

/** Modo no formato `drwxr-xr-x`, como o `tar -tv` mostra. */
export function modoLegivel(entrada) {
  const tipo = entrada.tipo === TIPOS.diretorio ? 'd' : entrada.tipo === TIPOS.simbolica ? 'l' : '-';
  const bits = ['r', 'w', 'x'];

  let texto = '';

  for (let grupo = 0; grupo < 3; grupo += 1) {
    for (let bit = 0; bit < 3; bit += 1) {
      texto += (entrada.modo >> (8 - grupo * 3 - bit)) & 1 ? bits[bit] : '-';
    }
  }

  return tipo + texto;
}

/** Data no formato do `tar -tv`. */
export function dataLegivel(data) {
  const dois = (n) => String(n).padStart(2, '0');

  return (
    `${data.getUTCFullYear()}-${dois(data.getUTCMonth() + 1)}-${dois(data.getUTCDate())} ` +
    `${dois(data.getUTCHours())}:${dois(data.getUTCMinutes())}`
  );
}

/** Uma linha de listagem. */
export function linhaDe(entrada, detalhado) {
  if (!detalhado) return entrada.nome;

  const seta = entrada.tipo === TIPOS.simbolica ? ` -> ${entrada.destino}` : '';

  return `${modoLegivel(entrada)} ${String(entrada.tamanho).padStart(9)} ${dataLegivel(entrada.alterado)} ${entrada.nome}${seta}`;
}

/** Lê os argumentos. */
export function lerArgumentos(argumentos) {
  const opcoes = { comando: null, arquivo: null, pasta: null, detalhado: false, fixar: false, semMedo: false, ajuda: false };
  const soltos = [];

  for (const arg of argumentos) {
    if (arg === '-h' || arg === '--ajuda') opcoes.ajuda = true;
    else if (arg === '-v' || arg === '--detalhado') opcoes.detalhado = true;
    else if (arg === '-f' || arg === '--fixar') opcoes.fixar = true;
    else if (arg === '-s' || arg === '--sem-medo') opcoes.semMedo = true;
    else if (arg.startsWith('-')) throw new Error(`Opção desconhecida: ${arg}.`);
    else soltos.push(arg);
  }

  [opcoes.comando = null, opcoes.arquivo = null, opcoes.pasta = null] = soltos;

  return opcoes;
}

/** Roda um comando e devolve o código de saída. */
export async function principal(argumentos, escrever = console.log) {
  let opcoes;

  try {
    opcoes = lerArgumentos(argumentos);
  } catch (erro) {
    escrever(erro.message);
    return 2;
  }

  if (opcoes.ajuda || opcoes.comando === null) {
    escrever(AJUDA);
    return opcoes.ajuda ? 0 : 2;
  }

  if (!['criar', 'listar', 'extrair'].includes(opcoes.comando)) {
    escrever(`Comando desconhecido: ${opcoes.comando}.\n\n${AJUDA}`);
    return 2;
  }

  if (opcoes.arquivo === null) {
    escrever('Informe o arquivo tar.');
    return 2;
  }

  if (opcoes.comando !== 'listar' && opcoes.pasta === null) {
    escrever('Informe a pasta.');
    return 2;
  }

  try {
    if (opcoes.comando === 'criar') {
      const bytes = await empacotar(opcoes.pasta, { alterado: opcoes.fixar ? new Date(0) : null });

      await writeFile(opcoes.arquivo, bytes);
      escrever(`${opcoes.arquivo}: ${listar(bytes).length} entrada(s), ${bytes.length} bytes.`);

      return 0;
    }

    const bytes = await readFile(opcoes.arquivo);

    if (opcoes.comando === 'listar') {
      for (const entrada of listar(bytes)) escrever(linhaDe(entrada, opcoes.detalhado));

      return 0;
    }

    const { escritos, recusados } = await extrair(bytes, opcoes.pasta, { pularPerigosas: opcoes.semMedo });

    escrever(`${escritos.length} entrada(s) extraída(s) para ${opcoes.pasta}.`);

    for (const nome of recusados) escrever(`  recusada (escaparia da pasta): ${nome}`);

    return 0;
  } catch (erro) {
    escrever(erro.message);
    return 1;
  }
}

/* c8 ignore start */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
/* c8 ignore stop */
