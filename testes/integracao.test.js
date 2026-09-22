import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Escritor, empacotar } from '../src/escritor.js';
import { buscar, extrair, listar } from '../src/leitor.js';
import { linhaDe, modoLegivel, principal } from '../src/cli.js';
import { TIPOS } from '../src/cabecalho.js';

const temporarios = [];

async function pasta(nome = 'arq') {
  const caminho = await mkdtemp(join(tmpdir(), `${nome}-`));

  temporarios.push(caminho);

  return caminho;
}

/** O `tar` do sistema, quando existe — a régua deste projeto. */
function temTar() {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SEM_TAR = temTar() ? false : 'tar não instalado';

/** Roda o `tar` do sistema numa pasta. */
function tar(cwd, ...args) {
  return execFileSync('tar', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

after(async () => {
  for (const caminho of temporarios) await rm(caminho, { recursive: true, force: true });
});

describe('o tar do sistema lê o que este escreve', () => {
  it('lista as entradas com os mesmos nomes', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-lista');
    const escritor = new Escritor();

    escritor.adicionarPasta('projeto');
    escritor.adicionar({ nome: 'projeto/leiame.md' }, '# projeto\n');
    escritor.adicionar({ nome: 'projeto/src/soma.js' }, 'export const somar = (a, b) => a + b;\n');

    await writeFile(join(trabalho, 'nosso.tar'), escritor.finalizar());

    const saida = tar(trabalho, '-tf', 'nosso.tar');

    assert.deepEqual(saida.trim().split('\n').map((l) => l.trim()), [
      'projeto/',
      'projeto/leiame.md',
      'projeto/src/soma.js',
    ]);
  });

  it('extrai o conteúdo byte a byte', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-extrai');
    const conteudo = 'linha 1\nlinha com acento: ção\nlinha 3\n';

    await writeFile(
      join(trabalho, 'nosso.tar'),
      new Escritor().adicionar({ nome: 'a.txt' }, conteudo).finalizar(),
    );

    await mkdir(join(trabalho, 'saida'));

    // `-C` em vez de passar o caminho absoluto: o GNU tar lê `C:...` como
    // `maquina:caminho` e tenta abrir um shell remoto.
    tar(trabalho, '-xf', 'nosso.tar', '-C', 'saida');

    assert.equal(await readFile(join(trabalho, 'saida', 'a.txt'), 'utf8'), conteudo);
  });

  it('o nome comprido chega inteiro, via entrada L do GNU', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-longo');
    const comprido = `${'diretorio-com-nome-bem-comprido/'.repeat(5)}arquivo.txt`;

    await writeFile(
      join(trabalho, 'nosso.tar'),
      new Escritor().adicionar({ nome: comprido }, 'oi').finalizar(),
    );

    assert.equal(tar(trabalho, '-tf', 'nosso.tar').trim(), comprido);
  });

  it('o conteúdo binário não é alterado', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-bin');
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

    await writeFile(join(trabalho, 'nosso.tar'), new Escritor().adicionar({ nome: 'dados.bin' }, bytes).finalizar());
    await mkdir(join(trabalho, 'saida'));

    tar(trabalho, '-xf', 'nosso.tar', '-C', 'saida');

    assert.deepEqual(await readFile(join(trabalho, 'saida', 'dados.bin')), bytes);
  });

  it('um byte trocado faz o tar recusar, o que prova que a soma é a dele', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-soma');
    const bytes = new Escritor().adicionar({ nome: 'a.txt' }, 'oi').finalizar();

    bytes[0] = 'b'.charCodeAt(0);

    await writeFile(join(trabalho, 'ruim.tar'), bytes);

    assert.throws(() => tar(trabalho, '-tf', 'ruim.tar'));
  });
});

describe('este lê o que o tar do sistema escreve', () => {
  it('as entradas batem em nome, tamanho e conteúdo', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-deles');

    await mkdir(join(trabalho, 'fonte', 'sub'), { recursive: true });
    await writeFile(join(trabalho, 'fonte', 'a.txt'), 'conteúdo do a\n');
    await writeFile(join(trabalho, 'fonte', 'sub', 'b.txt'), 'conteúdo do b\n');

    tar(trabalho, '-cf', 'deles.tar', 'fonte');

    const entradas = listar(await readFile(join(trabalho, 'deles.tar')));
    const nomes = entradas.map((e) => e.nome).sort();

    assert.deepEqual(nomes, ['fonte/', 'fonte/a.txt', 'fonte/sub/', 'fonte/sub/b.txt']);

    const bytes = await readFile(join(trabalho, 'deles.tar'));

    assert.equal(buscar(bytes, 'fonte/a.txt').conteudo.toString('utf8'), 'conteúdo do a\n');
  });

  it('o nome comprido gerado pelo tar volta inteiro', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-deles-longo');
    const fundo = join('fonte', 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));

    await mkdir(join(trabalho, fundo), { recursive: true });
    await writeFile(join(trabalho, fundo, 'arquivo.txt'), 'fundo\n');

    tar(trabalho, '-cf', 'deles.tar', 'fonte');

    const nomes = listar(await readFile(join(trabalho, 'deles.tar'))).map((e) => e.nome);
    const esperado = `${fundo.split(/[\\/]/).join('/')}/arquivo.txt`;

    assert.ok(nomes.includes(esperado), `não achei ${esperado} em ${nomes.join(', ')}`);
  });

  it('a pasta vazia do tar é reconhecida como pasta', { skip: SEM_TAR }, async () => {
    const trabalho = await pasta('arq-vazia');

    await mkdir(join(trabalho, 'fonte', 'vazia'), { recursive: true });

    tar(trabalho, '-cf', 'deles.tar', 'fonte');

    const entradas = listar(await readFile(join(trabalho, 'deles.tar')));
    const vazia = entradas.find((e) => e.nome === 'fonte/vazia/');

    assert.ok(vazia, 'a pasta vazia deveria estar no arquivo');
    assert.equal(vazia.tipo, TIPOS.diretorio);
  });
});

describe('ida e volta pelo disco', () => {
  it('empacotar e extrair devolve a mesma árvore', async () => {
    const origem = await pasta('arq-origem');
    const destino = await pasta('arq-destino');

    await mkdir(join(origem, 'src', 'util'), { recursive: true });
    await writeFile(join(origem, 'leiame.md'), '# projeto\n');
    await writeFile(join(origem, 'src', 'a.js'), 'export const a = 1;\n');
    await writeFile(join(origem, 'src', 'util', 'b.js'), 'export const b = 2;\n');

    const bytes = await empacotar(origem);

    await extrair(bytes, destino);

    assert.equal(await readFile(join(destino, 'leiame.md'), 'utf8'), '# projeto\n');
    assert.equal(await readFile(join(destino, 'src', 'util', 'b.js'), 'utf8'), 'export const b = 2;\n');
  });

  it('com a data fixada, empacotar duas vezes dá bytes idênticos', async () => {
    // Sem isso nenhuma verificação por hash funciona: o mesmo conteúdo
    // produz arquivos diferentes a cada execução.
    const origem = await pasta('arq-repetivel');

    await writeFile(join(origem, 'a.txt'), 'igual\n');

    const um = await empacotar(origem, { alterado: new Date(0) });
    const dois = await empacotar(origem, { alterado: new Date(0) });

    assert.deepEqual(um, dois);
  });

  it('o filtro deixa arquivos de fora', async () => {
    const origem = await pasta('arq-filtro');

    await writeFile(join(origem, 'fica.txt'), 'a');
    await writeFile(join(origem, 'sai.log'), 'b');

    const nomes = listar(await empacotar(origem, { ignorar: (n) => n.endsWith('.log') })).map((e) => e.nome);

    assert.deepEqual(nomes, ['fica.txt']);
  });

  it('ligação simbólica sobrevive quando o sistema permite', async () => {
    const origem = await pasta('arq-link');

    await writeFile(join(origem, 'alvo.txt'), 'x');

    try {
      await symlink('alvo.txt', join(origem, 'atalho.txt'));
    } catch {
      return; // No Windows sem privilégio não dá para criar; o teste não se aplica.
    }

    const entradas = listar(await empacotar(origem));
    const link = entradas.find((e) => e.nome === 'atalho.txt');

    assert.equal(link.tipo, TIPOS.simbolica);
    assert.equal(link.destino, 'alvo.txt');
  });
});

describe('extração segura', () => {
  it('entrada que sobe de pasta é recusada', async () => {
    // O "tar slip". Um extrator ingênuo escreveria em ../fora.txt.
    const destino = await pasta('arq-slip');
    const bytes = new Escritor().adicionar({ nome: '../fora.txt' }, 'invasor').finalizar();

    await assert.rejects(() => extrair(bytes, destino), /escaparia da pasta/);
    assert.equal(existsSync(join(destino, '..', 'fora.txt')), false);
  });

  it('com pularPerigosas ela é listada em vez de derrubar tudo', async () => {
    const destino = await pasta('arq-slip2');
    const escritor = new Escritor();

    escritor.adicionar({ nome: '../fora.txt' }, 'invasor');
    escritor.adicionar({ nome: 'bom.txt' }, 'legítimo');

    const { escritos, recusados } = await extrair(escritor.finalizar(), destino, { pularPerigosas: true });

    assert.deepEqual(recusados, ['../fora.txt']);
    assert.deepEqual(escritos, ['bom.txt']);
    assert.equal(await readFile(join(destino, 'bom.txt'), 'utf8'), 'legítimo');
  });

  it('ligação apontando para fora também é recusada', async () => {
    // Sem `..` no nome: o escape viria do destino da ligação.
    const destino = await pasta('arq-slip3');
    const bytes = new Escritor().adicionarSimbolica('atalho', '../../etc/passwd').finalizar();

    await assert.rejects(() => extrair(bytes, destino), /apontaria para fora/);
  });
});

describe('linha de comando', () => {
  /** Roda a CLI capturando a saída. */
  async function rodar(...argumentos) {
    const linhas = [];
    const codigo = await principal(argumentos, (l) => linhas.push(String(l)));

    return { codigo, saida: linhas.join('\n') };
  }

  it('criar, listar e extrair', async () => {
    const origem = await pasta('cli-origem');
    const destino = await pasta('cli-destino');

    await writeFile(join(origem, 'a.txt'), 'oi\n');

    const alvo = join(origem, '..', 'saida.tar');

    temporarios.push(alvo);

    assert.match((await rodar('criar', alvo, origem, '-f')).saida, /1 entrada\(s\)/);
    assert.equal((await rodar('listar', alvo)).saida, 'a.txt');
    assert.match((await rodar('listar', alvo, '-v')).saida, /^-rw.* {8}3 1970-01-01 00:00 a\.txt$/);
    assert.match((await rodar('extrair', alvo, destino)).saida, /1 entrada\(s\) extraída\(s\)/);
    assert.equal(await readFile(join(destino, 'a.txt'), 'utf8'), 'oi\n');
  });

  it('o modo sai como o tar -tv mostra', () => {
    assert.equal(modoLegivel({ modo: 0o644, tipo: TIPOS.arquivo }), '-rw-r--r--');
    assert.equal(modoLegivel({ modo: 0o755, tipo: TIPOS.diretorio }), 'drwxr-xr-x');
    assert.equal(modoLegivel({ modo: 0o777, tipo: TIPOS.simbolica }), 'lrwxrwxrwx');
  });

  it('a ligação aparece com a seta', () => {
    const linha = linhaDe(
      { nome: 'atalho', tipo: TIPOS.simbolica, destino: 'alvo', modo: 0o777, tamanho: 0, alterado: new Date(0) },
      true,
    );

    assert.match(linha, /atalho -> alvo$/);
  });

  it('argumento faltando e comando errado saem com 2', async () => {
    assert.equal((await rodar()).codigo, 2);
    assert.equal((await rodar('voar', 'x.tar')).codigo, 2);
    assert.equal((await rodar('criar')).codigo, 2);
    assert.equal((await rodar('criar', 'x.tar')).codigo, 2);
    assert.equal((await rodar('--inventada')).codigo, 2);
  });

  it('a ajuda sai com 0 e arquivo inexistente com 1', async () => {
    assert.equal((await rodar('--ajuda')).codigo, 0);
    assert.equal((await rodar('listar', join(tmpdir(), 'nao-existe-mesmo.tar'))).codigo, 1);
  });
});
