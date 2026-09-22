/**
 * O cabeçalho tar.
 *
 * Um arquivo `.tar` é só uma sequência de blocos de **512 bytes**: um
 * cabeçalho, o conteúdo do arquivo preenchido até fechar um múltiplo de 512,
 * outro cabeçalho, e assim por diante. Não há índice, não há compressão e não
 * há nada no fim além de dois blocos zerados.
 *
 * É por isso que `tar` sozinho não comprime (quem comprime é o gzip depois) e
 * por isso que extrair um arquivo do meio de um tar de 4 GB exige ler os 4 GB:
 * a única forma de achar o próximo cabeçalho é pular o conteúdo do atual.
 *
 * O campo mais curioso é a **soma de verificação**, calculada com o próprio
 * campo dela preenchido de espaços. Foi a solução de 1979 para um campo que
 * precisa cobrir a si mesmo, e todo mundo ainda faz assim.
 */

/** Todo bloco tem 512 bytes. Não há exceção. */
export const BLOCO = 512;

/** Posições dos campos dentro do cabeçalho, em bytes. */
export const CAMPOS = {
  nome: [0, 100],
  modo: [100, 8],
  dono: [108, 8],
  grupo: [116, 8],
  tamanho: [124, 12],
  alterado: [136, 12],
  soma: [148, 8],
  tipo: [156, 1],
  destino: [157, 100],
  marca: [257, 6],
  versao: [263, 2],
  nomeDoDono: [265, 32],
  nomeDoGrupo: [297, 32],
  maiorDispositivo: [329, 8],
  menorDispositivo: [337, 8],
  prefixo: [345, 155],
};

/** Os tipos de entrada que este projeto trata. */
export const TIPOS = {
  arquivo: '0',
  ligacao: '1',
  simbolica: '2',
  diretorio: '5',
  nomeLongoGnu: 'L',
  pax: 'x',
  paxGlobal: 'g',
};

/** O arquivo não está no formato esperado. */
export class ErroDeFormato extends Error {
  constructor(mensagem, deslocamento = null) {
    super(deslocamento === null ? mensagem : `${mensagem} (bloco em ${deslocamento})`);
    this.name = 'ErroDeFormato';
    this.deslocamento = deslocamento;
  }
}

/** Quantos bytes até fechar o próximo múltiplo de 512. */
export function enchimento(tamanho) {
  const resto = tamanho % BLOCO;

  return resto === 0 ? 0 : BLOCO - resto;
}

/** Lê um campo de texto, cortando no primeiro byte nulo. */
export function lerTexto(bloco, campo) {
  const [inicio, tamanho] = CAMPOS[campo];
  const bruto = bloco.subarray(inicio, inicio + tamanho);
  const fim = bruto.indexOf(0);

  return bruto.subarray(0, fim < 0 ? bruto.length : fim).toString('utf8').replace(/\0+$/, '');
}

/**
 * Lê um número em octal.
 *
 * Sim, octal: o formato é de 1979 e guarda números como texto em base 8,
 * terminado em nulo ou espaço. Campo vazio vale zero — é assim que um
 * diretório declara tamanho.
 *
 * A extensão GNU para arquivo acima de 8 GB liga o bit mais alto do primeiro
 * byte e guarda o número em binário. Sem tratar isso, um tar grande vira
 * "tamanho inválido".
 */
export function lerOctal(bloco, campo) {
  const [inicio, tamanho] = CAMPOS[campo];
  const bruto = bloco.subarray(inicio, inicio + tamanho);

  if ((bruto[0] & 0x80) !== 0) {
    let valor = BigInt(bruto[0] & 0x7f);

    for (let i = 1; i < bruto.length; i += 1) valor = (valor << 8n) | BigInt(bruto[i]);

    return Number(valor);
  }

  const texto = bruto.toString('ascii').replace(/[\0 ]+$/g, '').trim();

  if (texto === '') return 0;

  if (!/^[0-7]+$/.test(texto)) {
    throw new ErroDeFormato(`Campo ${campo} não é octal válido: ${JSON.stringify(texto)}`);
  }

  return Number.parseInt(texto, 8);
}

/** Escreve texto num campo, preenchendo o resto com nulos. */
export function escreverTexto(bloco, campo, valor) {
  const [inicio, tamanho] = CAMPOS[campo];
  const bytes = Buffer.from(String(valor), 'utf8');

  if (bytes.length > tamanho) {
    throw new ErroDeFormato(`O campo ${campo} cabe ${tamanho} bytes e recebeu ${bytes.length}`);
  }

  bloco.fill(0, inicio, inicio + tamanho);
  bytes.copy(bloco, inicio);
}

/**
 * Escreve um número em octal, terminado em nulo.
 *
 * O campo de 12 bytes guarda 11 dígitos octais, o que dá 8 GB. Acima disso o
 * formato clássico simplesmente não alcança, e é por isso que existe a
 * extensão em binário.
 */
export function escreverOctal(bloco, campo, valor) {
  const [inicio, tamanho] = CAMPOS[campo];
  const digitos = tamanho - 1;
  const maximo = 8 ** digitos - 1;

  if (valor > maximo) {
    throw new ErroDeFormato(
      `${valor} não cabe em ${digitos} dígitos octais no campo ${campo} (o máximo é ${maximo})`,
    );
  }

  const texto = Math.floor(valor).toString(8).padStart(digitos, '0');

  bloco.fill(0, inicio, inicio + tamanho);
  bloco.write(texto, inicio, 'ascii');
}

/**
 * Soma de verificação: todos os bytes, com o campo da soma valendo espaços.
 *
 * O campo precisa cobrir a si mesmo, e em 1979 a saída foi fingir que ele é
 * um branco de oito espaços na hora de somar. Quem calcula diferente produz
 * um tar que o `tar` do sistema recusa com "checksum error".
 */
export function somaDe(bloco) {
  const [inicio, tamanho] = CAMPOS.soma;

  let total = 0;

  for (let i = 0; i < BLOCO; i += 1) {
    total += i >= inicio && i < inicio + tamanho ? 0x20 : bloco[i];
  }

  return total;
}

/** Monta o bloco de cabeçalho de uma entrada. */
export function montarCabecalho(entrada) {
  const bloco = Buffer.alloc(BLOCO);

  const { nome, prefixo } = partirNome(entrada.nome);

  escreverTexto(bloco, 'nome', nome);
  escreverTexto(bloco, 'prefixo', prefixo);
  escreverOctal(bloco, 'modo', entrada.modo ?? 0o644);
  escreverOctal(bloco, 'dono', entrada.dono ?? 0);
  escreverOctal(bloco, 'grupo', entrada.grupo ?? 0);
  escreverOctal(bloco, 'tamanho', entrada.tipo === TIPOS.diretorio ? 0 : (entrada.tamanho ?? 0));
  escreverOctal(bloco, 'alterado', Math.floor((entrada.alterado ?? new Date()).getTime() / 1000));
  escreverTexto(bloco, 'tipo', entrada.tipo ?? TIPOS.arquivo);
  escreverTexto(bloco, 'destino', entrada.destino ?? '');

  // A marca `ustar\0` com versão `00` é o que distingue o POSIX do tar antigo.
  bloco.write('ustar\0', CAMPOS.marca[0], 'ascii');
  bloco.write('00', CAMPOS.versao[0], 'ascii');

  escreverTexto(bloco, 'nomeDoDono', entrada.nomeDoDono ?? '');
  escreverTexto(bloco, 'nomeDoGrupo', entrada.nomeDoGrupo ?? '');

  // A soma vai por último, porque depende de tudo que já foi escrito.
  const soma = somaDe(bloco);

  bloco.write(`${soma.toString(8).padStart(6, '0')}\0 `, CAMPOS.soma[0], 'ascii');

  return bloco;
}

/**
 * Parte um nome comprido entre `prefixo` e `nome`.
 *
 * O campo de nome tem 100 bytes. O ustar acrescentou um prefixo de 155, e os
 * dois se juntam com uma barra no meio — o que dá 255, mas **só se houver uma
 * barra numa posição que sirva**. `umnomedearquivosemBarra` de 120 caracteres
 * não cabe, por mais que 120 seja menor que 255.
 */
export function partirNome(caminho) {
  const bytes = Buffer.byteLength(caminho);

  if (bytes <= 100) return { nome: caminho, prefixo: '' };

  if (bytes > 255) {
    throw new ErroDeFormato(`O nome tem ${bytes} bytes; o ustar alcança 255 e precisa de uma barra no lugar certo`);
  }

  // A melhor divisão é a barra mais à direita que deixe o resto em 100 bytes.
  for (let i = caminho.length - 1; i >= 0; i -= 1) {
    if (caminho[i] !== '/') continue;

    const nome = caminho.slice(i + 1);
    const prefixo = caminho.slice(0, i);

    if (Buffer.byteLength(nome) <= 100 && Buffer.byteLength(prefixo) <= 155) return { nome, prefixo };
  }

  throw new ErroDeFormato(`Não há barra numa posição que parta "${caminho}" em 155 + 100 bytes`);
}

/** Junta prefixo e nome de volta. */
export function juntarNome(prefixo, nome) {
  return prefixo ? `${prefixo}/${nome}` : nome;
}

/** Lê um bloco de cabeçalho. Devolve `null` no bloco zerado que marca o fim. */
export function lerCabecalho(bloco, deslocamento = 0) {
  if (bloco.length !== BLOCO) {
    throw new ErroDeFormato(`Bloco com ${bloco.length} bytes; deveria ter ${BLOCO}`, deslocamento);
  }

  if (bloco.every((b) => b === 0)) return null;

  const declarada = lerOctal(bloco, 'soma');
  const calculada = somaDe(bloco);

  if (declarada !== calculada) {
    throw new ErroDeFormato(
      `Soma de verificação não bate: o cabeçalho diz ${declarada}, a conta dá ${calculada}`,
      deslocamento,
    );
  }

  const tipo = lerTexto(bloco, 'tipo') || TIPOS.arquivo;

  return {
    nome: juntarNome(lerTexto(bloco, 'prefixo'), lerTexto(bloco, 'nome')),
    modo: lerOctal(bloco, 'modo'),
    dono: lerOctal(bloco, 'dono'),
    grupo: lerOctal(bloco, 'grupo'),
    tamanho: lerOctal(bloco, 'tamanho'),
    alterado: new Date(lerOctal(bloco, 'alterado') * 1000),
    tipo,
    destino: lerTexto(bloco, 'destino'),
    nomeDoDono: lerTexto(bloco, 'nomeDoDono'),
    nomeDoGrupo: lerTexto(bloco, 'nomeDoGrupo'),
    ustar: lerTexto(bloco, 'marca').startsWith('ustar'),
  };
}
