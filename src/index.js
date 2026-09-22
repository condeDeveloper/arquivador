/**
 * arquivador — tar POSIX ustar, do zero.
 */

export {
  BLOCO,
  CAMPOS,
  ErroDeFormato,
  TIPOS,
  enchimento,
  escreverOctal,
  escreverTexto,
  juntarNome,
  lerCabecalho,
  lerOctal,
  lerTexto,
  montarCabecalho,
  partirNome,
  somaDe,
} from './cabecalho.js';

export { Escritor, NOME_LONGO, cabeNoUstar, empacotar, normalizar } from './escritor.js';
export { buscar, extrair, lerEntradas, lerPax, listar, resolverDentro } from './leitor.js';
