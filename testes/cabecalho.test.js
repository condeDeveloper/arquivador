import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
} from '../src/cabecalho.js';
import { Escritor, cabeNoUstar, normalizar } from '../src/escritor.js';
import { buscar, lerEntradas, lerPax, listar, resolverDentro } from '../src/leitor.js';

describe('o bloco de 512', () => {
  it('o cabeçalho ocupa exatamente um bloco', () => {
    assert.equal(montarCabecalho({ nome: 'a.txt', tamanho: 3 }).length, BLOCO);
  });

  it('os campos somam 500 e sobram 12 bytes reservados', () => {
    const fim = Math.max(...Object.values(CAMPOS).map(([inicio, tamanho]) => inicio + tamanho));

    assert.equal(fim, 500);
  });

  it('o enchimento fecha o próximo múltiplo de 512', () => {
    assert.equal(enchimento(0), 0);
    assert.equal(enchimento(1), 511);
    assert.equal(enchimento(512), 0);
    assert.equal(enchimento(513), 511);
    assert.equal(enchimento(1000), 24);
  });
});

describe('os campos', () => {
  it('texto vai e volta', () => {
    const bloco = Buffer.alloc(BLOCO);

    escreverTexto(bloco, 'nome', 'pasta/arquivo.txt');

    assert.equal(lerTexto(bloco, 'nome'), 'pasta/arquivo.txt');
  });

  it('texto que não cabe é recusado em vez de cortado', () => {
    const bloco = Buffer.alloc(BLOCO);

    assert.throws(() => escreverTexto(bloco, 'nome', 'x'.repeat(101)), /cabe 100 bytes/);
  });

  it('número vai em octal, porque o formato é de 1979', () => {
    const bloco = Buffer.alloc(BLOCO);

    escreverOctal(bloco, 'modo', 0o644);

    assert.equal(bloco.subarray(100, 107).toString('ascii'), '0000644');
    assert.equal(lerOctal(bloco, 'modo'), 0o644);
  });

  it('campo vazio vale zero, que é como um diretório declara tamanho', () => {
    assert.equal(lerOctal(Buffer.alloc(BLOCO), 'tamanho'), 0);
  });

  it('octal inválido é recusado', () => {
    const bloco = Buffer.alloc(BLOCO);

    bloco.write('99999999', CAMPOS.tamanho[0], 'ascii');

    assert.throws(() => lerOctal(bloco, 'tamanho'), /não é octal/);
  });

  it('o campo de 12 bytes alcança 8 GB e não mais', () => {
    const bloco = Buffer.alloc(BLOCO);
    const maximo = 8 ** 11 - 1;

    assert.doesNotThrow(() => escreverOctal(bloco, 'tamanho', maximo));
    assert.throws(() => escreverOctal(bloco, 'tamanho', maximo + 1), /não cabe em 11 dígitos/);
  });

  it('a extensão binária do GNU é entendida na leitura', () => {
    // Acima de 8 GB o GNU liga o bit mais alto e guarda em binário puro.
    const bloco = Buffer.alloc(BLOCO);
    const [inicio, tamanho] = CAMPOS.tamanho;

    bloco[inicio] = 0x80;
    bloco.writeUInt32BE(0x4_0000_000, inicio + tamanho - 4);

    assert.equal(lerOctal(bloco, 'tamanho'), 0x4_0000_000);
  });
});

describe('a soma de verificação', () => {
  it('é calculada com o próprio campo valendo espaços', () => {
    // O campo precisa cobrir a si mesmo; em 1979 a saída foi fingir que ele
    // é um branco de oito espaços na hora de somar.
    const bloco = montarCabecalho({ nome: 'a.txt', tamanho: 0 });
    const copia = Buffer.from(bloco);

    copia.fill(0x20, CAMPOS.soma[0], CAMPOS.soma[0] + CAMPOS.soma[1]);

    assert.equal(somaDe(bloco), somaDe(copia));
  });

  it('o cabeçalho montado confere na leitura', () => {
    const lido = lerCabecalho(montarCabecalho({ nome: 'a.txt', tamanho: 7, modo: 0o600 }));

    assert.equal(lido.nome, 'a.txt');
    assert.equal(lido.tamanho, 7);
    assert.equal(lido.modo, 0o600);
    assert.equal(lido.ustar, true);
  });

  it('um byte trocado é pego', () => {
    const bloco = montarCabecalho({ nome: 'a.txt', tamanho: 7 });

    bloco[0] = 'b'.charCodeAt(0);

    assert.throws(() => lerCabecalho(bloco), /Soma de verificação não bate/);
  });

  it('bloco zerado é o fim do arquivo, não um erro', () => {
    assert.equal(lerCabecalho(Buffer.alloc(BLOCO)), null);
  });

  it('bloco de tamanho errado é recusado', () => {
    assert.throws(() => lerCabecalho(Buffer.alloc(100)), ErroDeFormato);
  });
});

describe('nome comprido', () => {
  it('até 100 bytes cabe no campo de nome', () => {
    assert.deepEqual(partirNome('a'.repeat(100)), { nome: 'a'.repeat(100), prefixo: '' });
  });

  it('acima disso o ustar parte na barra mais à direita que serve', () => {
    const caminho = `${'p'.repeat(120)}/${'n'.repeat(80)}`;
    const { nome, prefixo } = partirNome(caminho);

    assert.equal(prefixo, 'p'.repeat(120));
    assert.equal(nome, 'n'.repeat(80));
    assert.equal(juntarNome(prefixo, nome), caminho);
  });

  it('120 caracteres sem barra nenhuma não cabem, por mais que 120 < 255', () => {
    // O limite não é 255: são dois campos separados, e sem barra no lugar
    // certo não há como dividir.
    assert.equal(cabeNoUstar('x'.repeat(120)), false);
    assert.throws(() => partirNome('x'.repeat(120)), /barra numa posição/);
  });

  it('acima de 255 bytes nem com barra', () => {
    assert.throws(() => partirNome(`${'a'.repeat(150)}/${'b'.repeat(150)}`), /alcança 255/);
  });

  it('o escritor usa a entrada L do GNU para o que não cabe', () => {
    const comprido = `${'x'.repeat(120)}.txt`;
    const escritor = new Escritor();

    escritor.adicionar({ nome: comprido }, 'oi');

    const entradas = listar(escritor.finalizar());

    assert.equal(entradas.length, 1);
    assert.equal(entradas[0].nome, comprido);
  });

  it('normalizar tira barra do começo e do fim', () => {
    assert.equal(normalizar('/a/b/'), 'a/b');
    assert.equal(normalizar('a\\b'.split('\\').join('/')), 'a/b');
  });
});

describe('o arquivo montado', () => {
  it('termina em dois blocos zerados', () => {
    // Um tar sem eles faz o GNU avisar "unexpected EOF".
    const bytes = new Escritor().adicionar({ nome: 'a.txt' }, 'oi').finalizar();

    assert.ok(bytes.subarray(-BLOCO * 2).every((b) => b === 0));
  });

  it('o tamanho é sempre múltiplo de 512', () => {
    const escritor = new Escritor();

    escritor.adicionar({ nome: 'a.txt' }, 'x'.repeat(700));
    escritor.adicionar({ nome: 'b.txt' }, 'y');

    assert.equal(escritor.finalizar().length % BLOCO, 0);
  });

  it('o conteúdo volta byte a byte', () => {
    const original = Buffer.from([0, 1, 2, 255, 0, 10]);
    const bytes = new Escritor().adicionar({ nome: 'bin' }, original).finalizar();

    assert.deepEqual(buscar(bytes, 'bin').conteudo, original);
  });

  it('arquivo vazio é uma entrada válida', () => {
    const bytes = new Escritor().adicionar({ nome: 'vazio' }, '').finalizar();

    assert.equal(buscar(bytes, 'vazio').tamanho, 0);
  });

  it('pasta e ligação simbólica têm o próprio tipo', () => {
    const escritor = new Escritor();

    escritor.adicionarPasta('src');
    escritor.adicionarSimbolica('atalho', 'src/a.js');

    const entradas = listar(escritor.finalizar());

    assert.equal(entradas[0].tipo, TIPOS.diretorio);
    assert.equal(entradas[0].nome, 'src/');
    assert.equal(entradas[1].tipo, TIPOS.simbolica);
    assert.equal(entradas[1].destino, 'src/a.js');
  });

  it('a data sobrevive à ida e volta, em segundos', () => {
    const quando = new Date(Math.floor(Date.now() / 1000) * 1000);
    const bytes = new Escritor().adicionar({ nome: 'a', alterado: quando }, 'x').finalizar();

    assert.equal(buscar(bytes, 'a').alterado.getTime(), quando.getTime());
  });

  it('escrever depois de finalizar reclama', () => {
    const escritor = new Escritor();

    escritor.finalizar();

    assert.throws(() => escritor.adicionar({ nome: 'tarde' }), /já foi finalizado/);
  });

  it('entrada sem nome é recusada', () => {
    assert.throws(() => new Escritor().adicionar({ nome: '' }), /sem nome/);
  });
});

describe('registros PAX', () => {
  it('o tamanho do registro inclui ele mesmo', () => {
    // Contar só o resto desalinha todos os registros seguintes.
    const um = '13 path=a.txt\n';
    const dois = '11 size=99\n';

    assert.equal(um.length, 14);

    const registros = lerPax(Buffer.from(`14 path=a.txt\n${dois}`));

    assert.equal(registros.path, 'a.txt');
    assert.equal(registros.size, '99');
  });

  it('registro com tamanho inválido é recusado', () => {
    assert.throws(() => lerPax(Buffer.from('xx path=a\n')), /tamanho inválido/);
  });

  it('registro vazio devolve objeto vazio', () => {
    assert.deepEqual({ ...lerPax(Buffer.alloc(0)) }, {});
  });
});

describe('arquivo truncado', () => {
  it('conteúdo que acaba antes do tamanho declarado é pego', () => {
    const bytes = new Escritor().adicionar({ nome: 'a' }, 'x'.repeat(600)).finalizar();

    assert.throws(() => listar(bytes.subarray(0, BLOCO + 100)), /acabou antes/);
  });

  it('arquivo sem os blocos finais ainda lista o que dá', () => {
    const escritor = new Escritor();

    escritor.adicionar({ nome: 'a' }, 'oi');

    const semFim = Buffer.concat(escritor.pedacos);

    assert.equal([...lerEntradas(semFim)].length, 1);
  });
});

describe('travessia de caminho', () => {
  it('recusa nome que sobe de pasta', () => {
    // O "tar slip": um arquivo malicioso traz `../../.ssh/authorized_keys`,
    // e um extrator ingênuo escreve exatamente ali.
    assert.equal(resolverDentro('/destino', '../fora.txt'), null);
    assert.equal(resolverDentro('/destino', 'a/../../fora.txt'), null);
  });

  it('aceita caminho que fica dentro', () => {
    assert.ok(resolverDentro('/destino', 'a/b.txt'));
    assert.ok(resolverDentro('/destino', 'a/../b.txt'));
  });
});
